'use strict';

/**
 * Minimal Sapo Admin REST API client for a Private App ("Ứng dụng riêng").
 *
 * Reference (fetched from support.sapo.vn):
 *  - Auth: HTTP Basic, apikey:apisecret embedded in the URL / Authorization
 *    header (https://support.sapo.vn/ung-dung-rieng-private-apps)
 *  - Orders:  GET /admin/orders/{id}.json         (support.sapo.vn/gioi-thieu-order-api)
 *  - Webhooks: POST /admin/webhooks.json           (support.sapo.vn/sapo-webhook)
 *  - Transactions: POST /admin/orders/{id}/transactions.json
 *                                                   (support.sapo.vn/transaction)
 *
 * `store` should be the store's Sapo hostname, e.g. "yourstore.mysapo.net"
 * (check your Sapo admin URL / Private App page for the exact host).
 */

function baseUrl(store) {
  return `https://${store}/admin`;
}

function authHeader(apiKey, apiSecret) {
  const token = Buffer.from(`${apiKey}:${apiSecret}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

async function request({ store, apiKey, apiSecret, method, path, body }) {
  const url = `${baseUrl(store)}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader(apiKey, apiSecret),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`Sapo API returned non-JSON (${res.status}) for ${method} ${path}: ${text.slice(0, 300)}`);
  }

  if (!res.ok) {
    throw new Error(`Sapo API error ${res.status} for ${method} ${path}: ${JSON.stringify(json)}`);
  }
  return json;
}

function makeClient({ store, apiKey, apiSecret }) {
  if (!store || !apiKey || !apiSecret) {
    throw new Error('Sapo client requires store, apiKey and apiSecret');
  }

  return {
    getOrder(orderId) {
      return request({ store, apiKey, apiSecret, method: 'GET', path: `/orders/${orderId}.json` });
    },

    listOrderTransactions(orderId) {
      return request({
        store,
        apiKey,
        apiSecret,
        method: 'GET',
        path: `/orders/${orderId}/transactions.json`,
      });
    },

    /**
     * Record a successful payment against an order. `kind: "sale"` records
     * an immediate authorize+capture, which is what a completed 9Pay card
     * payment represents. Sapo flips the order's financial_status once a
     * successful transaction exists (mirrors the same pattern used by its
     * built-in gateways).
     */
    createTransaction(orderId, { kind = 'sale', amount, gateway = '9Pay', status = 'success' } = {}) {
      return request({
        store,
        apiKey,
        apiSecret,
        method: 'POST',
        path: `/orders/${orderId}/transactions.json`,
        body: { transaction: { kind, amount: String(amount), gateway, status } },
      });
    },

    registerWebhook({ topic, address, format = 'json' }) {
      return request({
        store,
        apiKey,
        apiSecret,
        method: 'POST',
        path: '/webhooks.json',
        body: { webhook: { topic, address, format } },
      });
    },

    listWebhooks() {
      return request({ store, apiKey, apiSecret, method: 'GET', path: '/webhooks.json' });
    },

    listOrders({ limit = 50, page = 1 } = {}) {
      return request({
        store,
        apiKey,
        apiSecret,
        method: 'GET',
        path: `/orders.json?limit=${limit}&page=${page}&order=id+desc`,
      });
    },

    /**
     * Resolve the Sapo order-confirmation page token (the last path segment
     * of https://<store>/checkout/thankyou/<token>, exposed on the order
     * object as `token`) back to the numeric order id/object.
     *
     * Sapo's Orders API doesn't document a `?token=` filter (confirmed by
     * testing — the query param was silently ignored), so this scans the
     * most recent orders instead. Since the confirmation page redirects
     * within ~1s of order creation, the match is essentially always on the
     * first page; `maxPages` is just a safety margin for load spikes.
     */
    async findOrderByToken(token, { pageSize = 50, maxPages = 3 } = {}) {
      for (let page = 1; page <= maxPages; page += 1) {
        // eslint-disable-next-line no-await-in-loop
        const { orders = [] } = await request({
          store,
          apiKey,
          apiSecret,
          method: 'GET',
          path: `/orders.json?limit=${pageSize}&page=${page}&order=id+desc`,
        });
        const match = orders.find((o) => o.token === token);
        if (match) return match;
        if (orders.length < pageSize) break; // ran out of orders before maxPages
      }
      return null;
    },

    /**
     * ScriptTag API (mirrors Shopify's) — injects `<script src=...>` on
     * every storefront page, no per-page targeting. See registerRedirectScript.
     */
    listScriptTags() {
      return request({ store, apiKey, apiSecret, method: 'GET', path: '/script_tags.json' });
    },

    createScriptTag({ src, event = 'onload' }) {
      return request({
        store,
        apiKey,
        apiSecret,
        method: 'POST',
        path: '/script_tags.json',
        body: { script_tag: { src, event } },
      });
    },

    deleteScriptTag(id) {
      return request({ store, apiKey, apiSecret, method: 'DELETE', path: `/script_tags/${id}.json` });
    },
  };
}

module.exports = { makeClient };
