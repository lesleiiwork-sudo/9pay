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
 * handed to the server to look up.
 *
 * This calls GET /pay/check/by-token/:token via fetch — NOT a page
 * navigation — because Sapo also has no way to add a genuinely new,
 * customer-selectable checkout method (see README), so an existing
 * method's display name is repurposed as the "pay via 9Pay" choice and
 * every other order (COD, a real bank transfer, ...) must be left
 * untouched. The server decides whether this order's chosen method
 * actually matches; only then does this script navigate the page away.
 *
 * Fails open on purpose: any unexpected error, or a "no" from the server,
 * just leaves the confirmation page alone rather than risking breaking it
 * for a customer.
 */
function build(appBaseUrl) {
  return `(function () {
  try {
    var m = window.location.pathname.match(/\\/checkout\\/thankyou\\/([a-zA-Z0-9]+)/);
    if (!m) return; // not the confirmation page, do nothing

    var token = m[1];
    var guardKey = '9pay_redirect_' + token;
    // Guard against re-fetching / re-redirecting if the customer navigates
    // back here (e.g. browser back button) after already being sent to
    // 9Pay once.
    try {
      if (window.sessionStorage.getItem(guardKey)) return;
    } catch (e) { /* sessionStorage unavailable (privacy mode, etc) - continue anyway */ }

    fetch(${JSON.stringify(appBaseUrl)} + '/pay/check/by-token/' + encodeURIComponent(token))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.redirect || !data.url) return; // different payment method - leave the page alone
        try { window.sessionStorage.setItem(guardKey, '1'); } catch (e) {}
        window.location.replace(data.url);
      })
      .catch(function () { /* fail open: leave the confirmation page alone */ });
  } catch (e) {
    // Never break the real order-confirmation page for the customer.
  }
})();
`;
}

module.exports = { build };
