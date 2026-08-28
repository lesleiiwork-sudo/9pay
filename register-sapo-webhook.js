'use strict';

/**
 * One-off helper: registers the orders/create webhook on your Sapo store,
 * pointing at this bridge. Run once after deploying (and again if the
 * bridge's URL ever changes).
 *
 *   node scripts/register-sapo-webhook.js
 *
 * Requires the same env vars as the server (APP_BASE_URL, SAPO_*).
 * Only needed for integration flow (a) — see README.
 */

const config = require('../lib/config');
const { makeClient } = require('../lib/sapo');

async function main() {
  const sapo = makeClient(config.sapo);
  const address = `${config.appBaseUrl}/webhooks/sapo/order-created${
    config.sapoWebhookToken ? `?token=${encodeURIComponent(config.sapoWebhookToken)}` : ''
  }`;

  console.log('Registering webhook ->', address);
  const result = await sapo.registerWebhook({ topic: 'orders/create', address });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
