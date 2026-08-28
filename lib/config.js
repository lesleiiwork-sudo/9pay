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
};

module.exports = config;
