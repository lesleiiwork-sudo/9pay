'use strict';

const express = require('express');
const config = require('./lib/config');
const ninepay = require('./lib/ninepay');
const { makeClient } = require('./lib/sapo');

const app = express();
// 9Pay's IPN is x-www-form-urlencoded; Sapo webhooks send JSON.
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const sapo = makeClient(config.sapo);

// In-memory idempotency guard so a retried IPN doesn't double-book a
// transaction. Swap for a real DB/KV store before running more than one
// instance or across restarts.
const processedInvoices = new Set();

// Same caveat: in-memory, per-instance, resets on redeploy. Guards against
// emailing the same order's payment link twice (e.g. if Sapo retries its
// orders/create webhook).
const emailedOrders = new Set();

app.get('/health', (req, res) => res.json({ ok: true }));

/**
 * The Sapo checkout method actually used for an order, however Sapo happens
 * to report it (`gateway` on a plain order fetch, `payment_gateway_names`
 * on some others) — this is what config.ninePay.triggerGateway is compared
 * against everywhere below.
 */
function orderGateway(order) {
  return order.gateway || (Array.isArray(order.payment_gateway_names) ? order.payment_gateway_names[0] : null);
}

/**
 * Builds the signed 9Pay redirect URL for an order. Always works off a
 * fresh order fetched from Sapo, so the amount charged can never drift from
 * what Sapo actually has on file.
 */
function buildNinePayUrl(order) {
  const { url } = ninepay.buildPaymentUrl({
    endpoint: config.ninePay.endpoint,
    merchantKey: config.ninePay.merchantKey,
    merchantSecretKey: config.ninePay.merchantSecretKey,
    invoiceNo: String(order.id),
    amount: order.total_price,
    description: `Thanh toan don hang ${order.name || order.id}`,
    returnUrl: `${config.appBaseUrl}/9pay/return`,
  });
  return url;
}

/**
 * Shared by /pay/:orderId and /pay/by-token/:token — takes an already
 * resolved Sapo order object, checks it, and redirects straight to 9Pay.
 * Unconditional (no triggerGateway check): this is the direct pay-link
 * route for flow (a) / manual use, not what the storefront's auto-redirect
 * script calls (see /pay/check/by-token below for that).
 */
function sendToNinePay(res, order) {
  if (!order) return res.status(404).send('Không tìm thấy đơn hàng.');

  if (order.financial_status === 'paid') {
    return res.send('Đơn hàng này đã được thanh toán.');
  }

  return res.redirect(302, buildNinePayUrl(order));
}

/**
 * If the order was placed with the designated 9Pay checkout method (see
 * config.ninePay.triggerGateway) and isn't already paid, POSTs the
 * customer's email + payment link to config.emailLink.webhookUrl — an n8n
 * workflow that owns the real SMTP credentials and actually sends the
 * email (this service never sees them). No-op whenever that URL isn't
 * configured, the order used a different method (COD, a real bank
 * transfer, ...), or there's no email on file. Runs in parallel with the
 * on-page auto-redirect, not instead of it.
 */
async function maybeSendPaymentLinkEmail(order) {
  if (!order || !config.emailLink.webhookUrl) return;
  if (order.financial_status === 'paid') return;
  if (orderGateway(order) !== config.ninePay.triggerGateway) return;
  if (!order.email) return;
  if (emailedOrders.has(order.id)) return;
  emailedOrders.add(order.id);

  const customerName =
    (order.billing_address && order.billing_address.first_name) ||
    (order.shipping_address && order.shipping_address.first_name) ||
    '';

  const res = await fetch(config.emailLink.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: config.emailLink.webhookSecret,
      email: order.email,
      customerName,
      orderName: order.name || String(order.id),
      amount: order.total_price,
      paymentUrl: buildNinePayUrl(order),
    }),
  });
  if (!res.ok) {
    throw new Error(`email webhook responded ${res.status}`);
  }
}

/**
 * Entry point that actually sends the customer to 9Pay.
 *
 * Usage:
 *   https://<APP_BASE_URL>/pay/<sapo_order_id>
 *
 * Works for either integration flow described in the README:
 *   (a) emailed/SMS'd to the customer after checkout, or
 *   (b) the Sapo order-confirmation page's theme redirects here directly.
 */
app.get('/pay/:orderId', async (req, res) => {
  const { orderId } = req.params;
  try {
    const { order } = await sapo.getOrder(orderId);
    return sendToNinePay(res, order);
  } catch (err) {
    console.error('[/pay/:orderId] failed:', err);
    return res.status(502).send('Không tạo được liên kết thanh toán, vui lòng thử lại sau.');
  }
});

/**
 * Same as /pay/:orderId, but resolved from the *token* Sapo's own
 * order-confirmation page uses in its URL:
 *   https://<store>/checkout/thankyou/<token>
 * This is what lib/redirect-script.js (served at GET /static/redirect.js
 * and injected storefront-wide via a Sapo ScriptTag) calls, since that
 * page never exposes the numeric Sapo order id — only this token.
 */
app.get('/pay/by-token/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const order = await sapo.findOrderByToken(token);
    if (!order) {
      console.warn('[/pay/by-token] no order matched token', token);
      return res
        .status(404)
        .send('Không tìm thấy đơn hàng để thanh toán. Vui lòng kiểm tra email xác nhận hoặc liên hệ shop.');
    }
    return sendToNinePay(res, order);
  } catch (err) {
    console.error('[/pay/by-token/:token] failed:', err);
    return res.status(502).send('Không tạo được liên kết thanh toán, vui lòng thử lại sau.');
  }
});

/**
 * Called (via fetch, not a page navigation) by lib/redirect-script.js on
 * the order-confirmation page. Unlike /pay/by-token/:token above, this only
 * says "yes, redirect" when the order was actually placed with the
 * designated 9Pay checkout method (config.ninePay.triggerGateway) — so a
 * customer who chose COD or a real bank transfer sees their normal
 * confirmation page, untouched. Always responds 200 with JSON (never a
 * redirect itself) so a non-matching order just leaves the page alone.
 */
app.get('/pay/check/by-token/:token', async (req, res) => {
  try {
    const order = await sapo.findOrderByToken(req.params.token);
    if (!order || order.financial_status === 'paid') {
      return res.json({ redirect: false });
    }
    if (orderGateway(order) !== config.ninePay.triggerGateway) {
      return res.json({ redirect: false });
    }
    return res.json({ redirect: true, url: buildNinePayUrl(order) });
  } catch (err) {
    console.error('[/pay/check/by-token] failed:', err);
    return res.json({ redirect: false });
  }
});

/**
 * The actual script a Sapo ScriptTag loads (storefront-wide — Sapo's
 * ScriptTag API has no per-page "order status only" scope like Shopify's,
 * so the script itself has to detect the confirmation page). See
 * lib/redirect-script.js for the detection logic and why.
 */
app.get('/static/redirect.js', (req, res) => {
  res.type('application/javascript').send(require('./lib/redirect-script').build(config.appBaseUrl));
});

/**
 * Customer-facing return. This is for display only — never trust it to
 * mark an order paid, since it's just a browser redirect the customer
 * controls. The IPN handler below is the source of truth.
 */
app.get('/9pay/return', (req, res) => {
  const { result } = req.query;
  let status = 'unknown';
  if (result) {
    try {
      const payload = JSON.parse(Buffer.from(String(result), 'base64').toString('utf8'));
      status = payload.status === ninepay.STATUS.SUCCESS ? 'success' : 'pending_or_failed';
    } catch (err) {
      // ignore malformed payload, fall through to generic message
    }
  }
  res.send(
    status === 'success'
      ? 'Thanh toán thành công! Đơn hàng của bạn đang được xử lý.'
      : 'Giao dịch đang được xử lý hoặc chưa thành công. Vui lòng kiểm tra lại email xác nhận.'
  );
});

/**
 * 9Pay IPN: POST application/x-www-form-data with result/checksum/version.
 * This is the authoritative signal — verify the checksum, then write the
 * payment back to Sapo as an order transaction.
 */
app.post('/9pay/ipn', async (req, res) => {
  const { result, checksum } = req.body;

  const verification = ninepay.verifyResult({
    result,
    checksum,
    keyChecksum: config.ninePay.keyChecksum,
  });

  if (!verification.valid) {
    console.warn('[/9pay/ipn] rejected:', verification.reason);
    return res.status(400).json({ ok: false, reason: verification.reason });
  }

  const payment = verification.payload;
  console.log('[/9pay/ipn] verified payment:', payment);

  // Dedup: 9Pay may retry the IPN.
  const dedupeKey = `${payment.invoice_no}:${payment.payment_no}`;
  if (processedInvoices.has(dedupeKey)) {
    return res.json({ ok: true, note: 'already processed' });
  }

  if (payment.status !== ninepay.STATUS.SUCCESS) {
    // Not a success notification (9Pay only fires IPN on success per its
    // docs, but we double-check defensively).
    processedInvoices.add(dedupeKey);
    return res.json({ ok: true, note: `status ${payment.status}, no action taken` });
  }

  const sapoOrderId = payment.invoice_no; // we set invoice_no = Sapo order id in /pay/:orderId
  try {
    await sapo.createTransaction(sapoOrderId, {
      kind: 'sale',
      amount: payment.amount,
      gateway: '9Pay',
      status: 'success',
    });
    processedInvoices.add(dedupeKey);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[/9pay/ipn] failed to record Sapo transaction:', err);
    // Return 5xx so 9Pay retries the IPN later.
    return res.status(502).json({ ok: false, reason: 'sapo update failed' });
  }
});

/**
 * Sapo webhook receiver for the "orders/create" topic (register this URL
 * with sapo.registerWebhook — see scripts/register-sapo-webhook.js).
 *
 * Drives the parallel payment-link email (see maybeSendPaymentLinkEmail):
 * fires immediately when the order is created, independent of whether the
 * customer's browser ever loads the confirmation page / runs the
 * auto-redirect script — so it's a real backup channel, not a duplicate of
 * the same trigger. Re-fetches the order fresh from Sapo by id rather than
 * trusting the webhook payload's shape, for the same reason /pay/:orderId
 * does: the amount/gateway must always reflect what Sapo actually has on
 * file right now.
 */
app.post('/webhooks/sapo/order-created', async (req, res) => {
  if (config.sapoWebhookToken && req.query.token !== config.sapoWebhookToken) {
    return res.status(401).send('invalid token');
  }

  const orderId = req.body && req.body.id;
  console.log('[/webhooks/sapo/order-created] order', orderId, req.body && req.body.name);

  // Fire-and-forget: never let email dispatch delay or fail the webhook ack
  // (Sapo may retry the webhook if it doesn't get a prompt 200).
  if (orderId) {
    sapo
      .getOrder(orderId)
      .then(({ order }) => maybeSendPaymentLinkEmail(order))
      .catch((err) => console.error('[/webhooks/sapo/order-created] email dispatch failed:', err));
  }

  res.status(200).send('ok');
});

app.listen(config.port, () => {
  console.log(`9pay-sapo-bridge listening on :${config.port}`);
});
