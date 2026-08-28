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

app.get('/health', (req, res) => res.json({ ok: true }));

/**
 * Shared by /pay/:orderId and /pay/by-token/:token — takes an already
 * resolved Sapo order object, checks it, builds the signed 9Pay URL and
 * redirects. Always works off a fresh order fetched from Sapo, so the
 * amount charged can never drift from what Sapo actually has on file.
 */
function sendToNinePay(res, order) {
  if (!order) return res.status(404).send('Không tìm thấy đơn hàng.');

  if (order.financial_status === 'paid') {
    return res.send('Đơn hàng này đã được thanh toán.');
  }

  const { url } = ninepay.buildPaymentUrl({
    endpoint: config.ninePay.endpoint,
    merchantKey: config.ninePay.merchantKey,
    merchantSecretKey: config.ninePay.merchantSecretKey,
    invoiceNo: String(order.id),
    amount: order.total_price,
    description: `Thanh toan don hang ${order.name || order.id}`,
    returnUrl: `${config.appBaseUrl}/9pay/return`,
  });

  return res.redirect(302, url);
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
 * Only needed for integration flow (a): proactively notifying the
 * customer with a 9Pay payment link (e.g. by email) right after checkout.
 * If you go with flow (b) — the Sapo theme redirects straight to
 * /pay/:orderId — you don't need this webhook at all.
 */
app.post('/webhooks/sapo/order-created', async (req, res) => {
  if (config.sapoWebhookToken && req.query.token !== config.sapoWebhookToken) {
    return res.status(401).send('invalid token');
  }

  const order = req.body;
  console.log('[/webhooks/sapo/order-created] order', order.id, order.name);

  // TODO: send the customer an email/SMS containing
  //   `${config.appBaseUrl}/pay/${order.id}`
  // using whatever mail/SMS provider you use elsewhere (not wired up here
  // since it depends on that choice). Logging for now so you can see the
  // webhook is flowing end to end.

  res.status(200).send('ok');
});

app.listen(config.port, () => {
  console.log(`9pay-sapo-bridge listening on :${config.port}`);
});
