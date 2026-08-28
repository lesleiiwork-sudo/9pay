'use strict';

/**
 * Registers (or re-registers) the Sapo ScriptTag that injects
 * /static/redirect.js storefront-wide so the order-confirmation page
 * redirects to 9Pay. Run once after deploying (and again if APP_BASE_URL
 * ever changes, after first deleting the old one — Sapo doesn't have an
 * "update" endpoint for script tags, only create/list/delete).
 *
 *   node scripts/register-scripttag.js          # create
 *   node scripts/register-scripttag.js --list    # list existing
 *   node scripts/register-scripttag.js --delete <id>
 *
 * Requires APP_BASE_URL and SAPO_* env vars (same as the server).
 */

const config = require('../lib/config');
const { makeClient } = require('../lib/sapo');

async function main() {
  const sapo = makeClient(config.sapo);
  const [, , flag, arg] = process.argv;

  if (flag === '--list') {
    const result = await sapo.listScriptTags();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (flag === '--delete') {
    if (!arg) throw new Error('Usage: node scripts/register-scripttag.js --delete <script_tag_id>');
    const result = await sapo.deleteScriptTag(arg);
    console.log('Deleted.', JSON.stringify(result, null, 2));
    return;
  }

  const src = `${config.appBaseUrl}/static/redirect.js`;
  console.log('Registering ScriptTag ->', src);
  console.log(
    'NOTE: Sapo ScriptTags run on EVERY storefront page (no order-status-only scope). ' +
      'The script itself only acts on /checkout/thankyou/<token> URLs - see lib/redirect-script.js.'
  );
  const result = await sapo.createScriptTag({ src, event: 'onload' });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
