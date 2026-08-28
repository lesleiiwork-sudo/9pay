# 9Pay ⇄ Sapo bridge

Connects 9Pay's international-card **Redirect** payment gateway
(https://developers.9pay.vn/thanh-toan-the-quoc-te/redirect) to a Sapo
storefront.

## Why this exists

Sapo's checkout only offers payment gateways that Sapo has built in-house and
listed in its App Store (VNPAY, OnePay, PayOn, Techcombank VietQR PRO, OCB,
AFTEE, …). There is currently no 9Pay app there, so there's no "paste your
merchant key here" screen inside Sapo for it — unlike, say, VNPAY. This small
service fills that gap, the same way SePay/payOS/Casso do for bank-transfer
reconciliation: it sits between the two, builds signed 9Pay payment links,
and writes the result back into Sapo as an order transaction.

## How it works

```
Customer checks out on Sapo
        │
        ▼
Sapo order created (financial_status = pending)
        │
        ▼
Customer is sent to  GET /pay/:orderId  on this service
        │  (re-fetches the order from Sapo, builds a signed 9Pay URL)
        ▼
Customer redirected to 9Pay's hosted "portal" page, enters card details
        │
        ├── 9Pay → POST /9pay/ipn  (server-to-server, authoritative)
        │        verifies checksum → records a "sale" transaction on the
        │        Sapo order via the Transaction API → Sapo flips the order
        │        to financial_status = paid
        │
        └── 9Pay → browser redirect → GET /9pay/return (display only)
```

### Sapo cannot show "9Pay" as a checkout option — confirmed the hard way

Sapo's checkout only ever shows three kinds of payment method: its own
integrated App Store gateways (VNPAY, MoMo, KBank, ...), exactly one manual
"Chuyển khoản" bank-transfer entry, and COD. Anything else you add from
Cấu hình > Phương thức thanh toán > "Thêm phương thức" (any `Loại phương
thức` other than "Chuyển khoản") lands under "Phương thức khác", which Sapo
reserves for admin/POS bookkeeping only — it **never** appears on the real
storefront checkout, confirmed live against `monatblue.com/checkout`. So
there is no way, via Sapo's own settings, to add a genuinely new
customer-selectable "pay by 9Pay card" option.

The workaround: repurpose the one existing "Chuyển khoản" method's display
name (`config.ninePay.triggerGateway`, env `NINEPAY_TRIGGER_GATEWAY`) as the
de-facto "pay via 9Pay" choice. Sapo does record whichever method the
customer actually picked on the order's `gateway` field at the moment the
order is created (confirmed against real orders: COD orders show
`gateway: "Thu hộ (COD)"`, bank-transfer orders show `gateway: "Chuyển
khoản"`), so every 9Pay-specific behavior below checks that field first and
only acts when it matches exactly — an order placed with COD or a real bank
transfer is left completely alone.

### Getting the customer to the 9Pay payment link — both run in parallel

1. **Near-instant redirect on the confirmation page.** The Sapo
   order-confirmation page (`/checkout/thankyou/<token>`) isn't part of the
   theme at all — it's a system page, not a template asset (confirmed: none
   of the theme's 529 asset files match it). So this doesn't use theme
   editing. Instead it uses Sapo's **ScriptTag API**
   (`POST /admin/script_tags.json`, mirrors Shopify's) to inject
   `GET /static/redirect.js` (see `lib/redirect-script.js`) on every
   storefront page load. Sapo's ScriptTag has no per-page scope (unlike
   Shopify's `display_scope: "order_status"`), so the script itself checks
   `location.pathname` for `/checkout/thankyou/<token>` before doing
   anything, then calls `GET /pay/check/by-token/<token>` **via `fetch`,
   not a page navigation** (the confirmation page doesn't expose the
   numeric Sapo order id anywhere, only that token — `by-token` resolves it
   server-side by scanning recent orders for a matching `token` field,
   since Sapo's Orders API doesn't support filtering by it directly). The
   server only answers `{redirect: true, url}` when the order's `gateway`
   matches `NINEPAY_TRIGGER_GATEWAY`; only then does the script navigate
   the page away. Any other order's confirmation page is left untouched.

2. **Payment-link email, as a backup.** Sapo calls
   `POST /webhooks/sapo/order-created` right after checkout; the handler
   re-fetches the order, and — again only when its `gateway` matches
   `NINEPAY_TRIGGER_GATEWAY` — POSTs the customer's email and payment link
   to `EMAIL_LINK_WEBHOOK_URL`, an n8n workflow that owns the real SMTP
   credentials and sends the actual email (this service never touches SMTP
   secrets). This fires server-side at order creation, independent of
   whatever happens in the customer's browser afterward — a genuine backup
   if the redirect script never runs (closed tab, JS disabled, ad blocker),
   not just a duplicate of the same trigger. Leave `EMAIL_LINK_WEBHOOK_URL`
   unset to disable this channel; the redirect keeps working either way.

## What's verified vs. what isn't

**Verified in this session**, against 9Pay's own docs and official sample
code (fetched live from developers.9pay.vn and
gitlab.com/9pay-sample/sample-javascript /sample-php):
- The HMAC-SHA256 signature algorithm — `lib/ninepay.js`'s `canonicalParams`/
  `sign` output was checked byte-for-byte against 9Pay's official Node.js
  sample (`link.js`) with fixed inputs and matched exactly.
- The IPN/return checksum verification (`verifyResult`) — round-tripped
  against 9Pay's documented example format.
- The Sapo REST client (`lib/sapo.js`) — auth header, URL construction, and
  request/response handling tested against a mocked HTTP layer.
- The confirmation-page detection: fetched a real completed order's
  `/checkout/thankyou/<token>` page live, confirmed the URL pattern, and
  confirmed `<token>` there equals that order's `token` field via the
  Sapo Admin API (order #4041W, id 287443274). Also confirmed the theme's
  529 asset files contain no checkout/confirmation template — this page
  is a system page, not theme-editable, so ScriptTag is the only lever.

**Not verified (couldn't be, from here) — please confirm before go-live:**
- The **production** 9Pay endpoint host. Sandbox is confirmed as
  `https://sand-payment.9pay.vn`; production is very likely
  `https://payment.9pay.vn` by the same naming convention 9Pay uses
  elsewhere, but I didn't find that written down anywhere public — check
  with 9Pay support or your merchant contact before switching
  `NINEPAY_ENDPOINT`.
- **Sapo's webhook authenticity check.** Sapo's public docs describe
  registering webhooks but don't spell out an HMAC header the way, e.g.,
  Shopify's `X-Shopify-Hmac-Sha256` is documented. I've used a simple shared
  `?token=` query string as a stand-in (`SAPO_WEBHOOK_TOKEN`). Check your
  Sapo Private App's webhook settings page for an actual signing
  secret/header and swap in real verification if one exists — this only
  matters for integration flow (1) above.
- I haven't run this end-to-end against the real sandbox merchant account,
  since that means charging a live (test) card and receiving a real IPN,
  which needs a public URL. Test that as the first step after deploying.
- `npm install` hasn't been run in this environment (its network is locked
  to a small allowlist that doesn't include the npm registry) — the `express`
  dependency is standard and the code was syntax-checked, but run
  `npm install && npm start` yourself as the first smoke test.

## Setup

```bash
npm install
cp .env.example .env
# fill in .env: 9Pay sandbox keys you already have, Sapo store + private
# app key/secret, and APP_BASE_URL once you know where this is deployed
npm start
```

Test locally first with a tunnel (e.g. `ngrok http 3000`) so 9Pay's IPN and
Sapo's webhook can reach you before deploying anywhere permanent.

### Deploying

Any Node host works (this is a plain Express app, no special runtime
needs). If you don't have hosting picked yet, low-effort options:
- **Render.com** — free/low-cost "Web Service", connect a git repo, set the
  env vars from `.env.example` in its dashboard, done.
- **Railway.app** — similar, usage-based pricing.
- Your own VPS with `pm2` or a systemd service, if you'd rather keep it
  in-house.

Whichever you pick, set `APP_BASE_URL` to the final public URL *before*
registering the Sapo webhook or going live with 9Pay, since it's baked into
the `return_url` sent to 9Pay on every payment link.

### Registering the redirect ScriptTag (flow 2, the one we're using)

```bash
node scripts/register-scripttag.js
```

This calls `POST /admin/script_tags.json` on your store, pointing at
`/static/redirect.js` on this service — **run it only after deploying**,
since Sapo needs `APP_BASE_URL` to already be a real, reachable URL for the
script to load at all. It goes live storefront-wide immediately.

To check what's registered or remove it: `node scripts/register-scripttag.js --list`
/ `--delete <script_tag_id>`. Sapo has no "update" endpoint for script
tags — if `APP_BASE_URL` ever changes, delete the old one and register a
new one.

### Registering the Sapo webhook (needed for the payment-link email backup)

```bash
node scripts/register-sapo-webhook.js
```

This calls `POST /admin/webhooks.json` on your store for the
`orders/create` topic, pointing at `/webhooks/sapo/order-created` on this
service. Only needed if you're using the parallel payment-link email
(`EMAIL_LINK_WEBHOOK_URL` set) — the on-page redirect alone doesn't need
it.

## Files

- `lib/ninepay.js` — signature, redirect-URL builder, IPN/return checksum
  verification, and the Authorization-header signer for 9Pay's other
  server-to-server APIs (inquire/refund), in case you need those later.
- `lib/sapo.js` — Sapo Admin REST client (orders, order lookup by
  confirmation-page token, transactions, webhooks, script tags) using
  Private App Basic Auth.
- `lib/redirect-script.js` — the JS injected storefront-wide by the
  ScriptTag; detects the confirmation page and redirects to 9Pay.
- `server.js` — the Express app and all routes.
- `scripts/register-scripttag.js` — one-off ScriptTag registration
  (flow 2, the one we're using) — also `--list` / `--delete`.
- `scripts/register-sapo-webhook.js` — one-off webhook registration
  (flow 1, not used here).

## Security notes

- Never commit `.env` — it holds `NINEPAY_MERCHANT_SECRET_KEY`,
  `NINEPAY_KEY_CHECKSUM`, and `SAPO_API_SECRET`.
- The Merchant View login (sand-business.9pay.vn) you were given is for
  9Pay's human dashboard, not something this service needs to log into —
  it's separate from the API keys used here.
- Once this is live, rotate the sandbox keys before reusing them in any
  shared document, since they were pasted in plaintext in chat.
