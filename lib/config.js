'use strict';

function required(name) {
  const v = process.env[name];
  if (!v) {
    // eslint-disable-next-line no-console
    console.warn(`[config] Warning: environment variable ${name} is not set`);
  }
  return v;
}

const config = {
  port: process.env.PORT || 3000,
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',

  ninePay: {
    endpoint: process.env.NINEPAY_ENDPOINT || 'https://sand-payment.9pay.vn',
    merchantKey: required('NINEPAY_MERCHANT_KEY'),
    merchantSecretKey: required('NINEPAY_MERCHANT_SECRET_KEY'),
    keyChecksum: required('NINEPAY_KEY_CHECKSUM'),

    // Sapo has no way to add a genuinely new, customer-selectable payment
    // method at checkout (confirmed: only its "Chuyển khoản" manual method,
    // native integrated gateways, and COD ever show up there — anything
    // else you add under "Phương thức khác" is admin/POS-bookkeeping only
    // and never appears on the storefront). So this repurposes one existing
    // checkout option's exact display name as the de-facto "pay via 9Pay"
    // choice, and every 9Pay-specific behavior below (auto-redirect, the
    // payment-link email) only fires for orders whose `gateway` matches
    // this string exactly. Orders placed with any other method (COD, a real
    // bank transfer, etc.) are left alone. Must match the payment method's
    // "Tên phương thức" in Sapo admin (Cấu hình > Phương thức thanh toán)
    // byte-for-byte.
    triggerGateway: process.env.NINEPAY_TRIGGER_GATEWAY || 'Chuyển khoản',
  },

  sapo: {
    store: required('SAPO_STORE'), // e.g. "yourstore.mysapo.net"
    apiKey: required('SAPO_API_KEY'),
    apiSecret: required('SAPO_API_SECRET'),
  },

  // Shared secret appended as a query param on the Sapo webhook URL, e.g.
  // .../webhooks/sapo/order-created?token=xxxx , so we can reject requests
  // that don't know it. This is a pragmatic stand-in: Sapo's public docs
  // don't spell out an HMAC header name for private-app webhooks the way
  // Shopify's X-Shopify-Hmac-Sha256 is documented, so verify the exact
  // mechanism from your own Sapo admin/webhook settings and harden this
  // before going live (see README "Open questions").
  sapoWebhookToken: process.env.SAPO_WEBHOOK_TOKEN || '',

  // Optional second channel, run in parallel with the on-page auto-redirect:
  // when a new order comes in via the Sapo `orders/create` webhook and its
  // gateway matches ninePay.triggerGateway, POST to this URL so it can email
  // the customer their 9Pay payment link directly (useful if the customer
  // closes the confirmation page, has JS disabled, etc., before the
  // in-browser redirect fires). This service deliberately never touches
  // real SMTP credentials itself — webhookUrl points at an n8n workflow
  // that owns those and sends the actual email. Leave webhookUrl unset to
  // disable this channel entirely (the on-page redirect keeps working).
  emailLink: {
    webhookUrl: process.env.EMAIL_LINK_WEBHOOK_URL || '',
    webhookSecret: process.env.EMAIL_LINK_WEBHOOK_SECRET || '',
  },
};

module.exports = config;
