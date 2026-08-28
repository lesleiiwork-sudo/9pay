'use strict';

/**
 * 9Pay "Redirect" integration helper.
 *
 * Reference (fetched from https://developers.9pay.vn/danh-sach-api and
 * https://developers.9pay.vn/thanh-toan-the-quoc-te/redirect, plus the
 * official sample at https://gitlab.com/9pay-sample/sample-php):
 *
 *   Signature = base64( HMAC-SHA256(
 *     "<METHOD>\n<URI>\n<unix_timestamp>\n<canonicalParams>",
 *     merchant_secret_key
 *   ))
 *
 *   canonicalParams = params sorted by key (ksort), then
 *     urlencode(key) + "=" + urlencode(value) joined with "&"
 *
 * For the redirect/portal flow specifically, the URI used in the message
 * is always "<endpoint>/payments/create" (POST) even though the customer
 * is actually sent to "<endpoint>/portal?...".
 *
 * IMPORTANT encoding detail: the canonical string must be built with
 * application/x-www-form-urlencoded encoding (spaces -> "+", via
 * URLSearchParams), matching 9Pay's own PHP (urlencode) and official
 * Node.js sample (https://gitlab.com/9pay-sample/sample-javascript,
 * link.js — uses URLSearchParams under the hood). Using
 * encodeURIComponent() directly would leave spaces as "%20" and a few
 * other characters unescaped, producing a signature 9Pay would reject
 * for any description/value containing spaces or punctuation.
 */

const crypto = require('crypto');

function canonicalParams(params) {
  const keys = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .sort();
  const qs = new URLSearchParams();
  for (const k of keys) qs.append(k, String(params[k]));
  return qs.toString();
}

function buildMessage({ method, uri, time, params }) {
  const parts = [method, uri, String(time)];
  const canon = canonicalParams(params);
  if (canon) parts.push(canon);
  return parts.join('\n');
}

function sign(message, secretKey) {
  return crypto.createHmac('sha256', secretKey).update(message, 'utf8').digest('base64');
}

/**
 * Build the URL to redirect the customer's browser to 9Pay's hosted
 * payment page ("portal").
 *
 * @param {object} opts
 * @param {string} opts.endpoint       e.g. https://sand-payment.9pay.vn
 * @param {string} opts.merchantKey
 * @param {string} opts.merchantSecretKey
 * @param {string} opts.invoiceNo      unique per payment attempt, <=30 chars
 * @param {number} opts.amount         VND, integer, 10000..200000000
 * @param {string} opts.description    <=255 chars
 * @param {string} opts.returnUrl      where 9Pay sends the browser back to
 * @param {string} [opts.backUrl]      "cancel and go back" URL shown by 9Pay
 * @param {string} [opts.currency]     default VND
 * @param {string} [opts.method]       e.g. CREDIT_CARD to skip method picker
 * @param {string} [opts.lang]         'vi' | 'en'
 * @returns {{url: string, data: object, signature: string}}
 */
function buildPaymentUrl(opts) {
  const {
    endpoint,
    merchantKey,
    merchantSecretKey,
    invoiceNo,
    amount,
    description,
    returnUrl,
    backUrl,
    currency,
    method,
    lang,
  } = opts;

  if (!endpoint) throw new Error('9Pay: endpoint is required');
  if (!merchantKey) throw new Error('9Pay: merchantKey is required');
  if (!merchantSecretKey) throw new Error('9Pay: merchantSecretKey is required');
  if (!invoiceNo) throw new Error('9Pay: invoiceNo is required');
  if (!amount) throw new Error('9Pay: amount is required');
  if (!returnUrl) throw new Error('9Pay: returnUrl is required');

  const time = Math.floor(Date.now() / 1000);

  const data = {
    merchantKey,
    time,
    invoice_no: String(invoiceNo),
    amount: Math.round(Number(amount)),
    description: description || `Thanh toan don hang ${invoiceNo}`,
    return_url: returnUrl,
  };
  if (backUrl) data.back_url = backUrl;
  if (currency) data.currency = currency;
  if (method) data.method = method;
  if (lang) data.lang = lang;

  const message = buildMessage({
    method: 'POST',
    uri: `${endpoint}/payments/create`,
    time,
    params: data,
  });

  const signature = sign(message, merchantSecretKey);

  const query = new URLSearchParams({
    baseEncode: Buffer.from(JSON.stringify(data), 'utf8').toString('base64'),
    signature,
  });

  return {
    url: `${endpoint}/portal?${query.toString()}`,
    data,
    signature,
  };
}

/**
 * Verify + decode the `result`/`checksum` pair 9Pay sends both to the
 * IPN endpoint (POST x-www-form-data) and appended to return_url.
 *
 * checksum = strtoupper( sha256( result + key_checksum ) )
 */
function verifyResult({ result, checksum, keyChecksum }) {
  if (!result || !checksum || !keyChecksum) {
    return { valid: false, reason: 'missing result/checksum/keyChecksum' };
  }
  const expected = crypto
    .createHash('sha256')
    .update(result + keyChecksum, 'utf8')
    .digest('hex')
    .toUpperCase();

  const valid = expected === String(checksum).toUpperCase();
  if (!valid) {
    return { valid: false, reason: 'checksum mismatch' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(result, 'base64').toString('utf8'));
  } catch (err) {
    return { valid: false, reason: `result is not valid base64/JSON: ${err.message}` };
  }

  return { valid: true, payload };
}

// Transaction status codes seen in 9Pay's docs/sample (status field in the
// decoded IPN/return payload). 5 = success is the only one confirmed by
// 9Pay's own sample code; the rest are inferred from support pages and
// should be treated as best-effort until confirmed with 9Pay.
const STATUS = {
  SUCCESS: 5,
  PROCESSING_A: 2,
  PROCESSING_B: 4,
  FAILED: 6,
  CANCELLED: 8,
  EXPIRED: 15,
};

/**
 * Build the signed Authorization header 9Pay's server-to-server APIs
 * (inquire, refund, etc.) require, per the "Xác thực" section of
 * https://developers.9pay.vn/danh-sach-api
 */
function buildAuthHeaders({ method, uri, merchantKey, merchantSecretKey, params }) {
  const time = Math.floor(Date.now() / 1000);
  const message = buildMessage({ method, uri, time, params: params || {} });
  const signature = sign(message, merchantSecretKey);
  return {
    Date: String(time),
    Authorization: `Signature Algorithm=HS256,Credential=${merchantKey},SignedHeaders=,Signature=${signature}`,
  };
}

module.exports = {
  canonicalParams,
  buildMessage,
  sign,
  buildPaymentUrl,
  verifyResult,
  buildAuthHeaders,
  STATUS,
};
