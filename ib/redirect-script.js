'use strict';

/**
 * The JS injected storefront-wide by a Sapo ScriptTag (see
 * scripts/register-scripttag.js). Sapo's ScriptTag API has no per-page
 * scope (unlike Shopify's `display_scope: "order_status"`), so this file
 * runs on *every* page and has to detect the order-confirmation page
 * itself before doing anything.
 *
 * Detection is by URL path, confirmed against a real completed order on
 * the live store: the confirmation page is always
 *   https://<store>/checkout/thankyou/<token>
 * and that <token> is exactly the Sapo order's `token` field (NOT the
 * `checkout_token` used in the earlier /checkout/<checkout_token> step).
 * There's no reliable global JS variable exposing the order id on that
 * page (checked: no window.Sapo, no iwish_template) — so the token is
 * handed to GET /pay/by-token/:token, which looks the order up server-side.
 *
 * Fails open on purpose: any unexpected error just leaves the confirmation
 * page alone rather than risking breaking it for a customer.
 */
function build(appBaseUrl) {
  return `(function () {
  try {
    var m = window.location.pathname.match(/\\/checkout\\/thankyou\\/([a-zA-Z0-9]+)/);
    if (!m) return; // not the confirmation page, do nothing

    var token = m[1];
    var guardKey = '9pay_redirect_' + token;
    // Guard against a redirect loop if the customer navigates back here
    // (e.g. browser back button) after already being sent to 9Pay once.
    try {
      if (window.sessionStorage.getItem(guardKey)) return;
      window.sessionStorage.setItem(guardKey, '1');
    } catch (e) { /* sessionStorage unavailable (privacy mode, etc) - continue anyway */ }

    window.location.replace(${JSON.stringify(appBaseUrl)} + '/pay/by-token/' + encodeURIComponent(token));
  } catch (e) {
    // Never break the real order-confirmation page for the customer.
  }
})();
`;
}

module.exports = { build };
