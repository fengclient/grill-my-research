import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaidServer, paidConfig } from '../src/paid-server.mjs';
import { PaidError } from '../src/alipay.mjs';
import { newRequest, proofHeader } from './paid-fixtures.mjs';

test('startup rejects missing config, socket/fallback DB, unsafe production TLS, invalid price and limits', () => {
  assert.throws(() => paidConfig({}));
  const env = { DATABASE_URL: 'postgresql://localhost/test', DEEPSEEK_API_KEY: 'key', ALIPAY_SERVICE_ID: 'service', ALIPAY_ENVIRONMENT: 'sandbox' };
  assert.equal(paidConfig(env).priceFen, 99);
  for (const changed of [{ DATABASE_URL: 'file:orders.json' }, { DATABASE_URL: 'postgresql:///test' }, { ALIPAY_ENVIRONMENT: 'production' }, { SKU_PRICE_FEN: '0' }, { SKU_PRICE_FEN: '5001' }, { SKU_EXECUTION_TIMEOUT_MS: '900000' }]) assert.throws(() => paidConfig({ ...env, ...changed }));
});

test('HTTP maps contract, omits bill header on invalid payment, GET only recovers, errors log no private values', async t => {
  const calls = [];
  const logs = [];
  let result = { kind: 'payment_required', amount: '0.99', paymentLink: 'amt_test' };
  let fail = null;
  const server = createPaidServer({ log: row => logs.push(row), service: {
    request: async value => { calls.push(['post', value]); if (fail) throw fail; return result; },
    recover: async value => { calls.push(['get', value]); return result; },
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = newRequest();
  const options = { method: 'POST', headers: { authorization: `Bearer ${request.recoverySecret}`, 'content-type': 'application/json' }, body: JSON.stringify({ orderId: request.orderId, target: request.target }) };
  let response = await fetch(`${base}/v1/verify`, options);
  assert.equal(response.status, 402); assert.equal(response.headers.get('amtPaymentLink'), 'amt_test');
  for (const [kind, status] of [['report', 200], ['running', 202], ['needs_review', 409]]) {
    result = { kind, orderId: request.orderId };
    response = await fetch(`${base}/v1/verify`, options); assert.equal(response.status, status);
  }
  fail = new PaidError(402, 'PAYMENT_INVALID');
  response = await fetch(`${base}/v1/verify`, { ...options, headers: { ...options.headers, 'Payment-Proof': proofHeader() } });
  assert.equal(response.status, 402); assert.equal(response.headers.get('amtPaymentLink'), null);
  assert.deepEqual(await response.json(), { error: 'PAYMENT_INVALID' });
  fail = new Error(`private ${request.recoverySecret} ${proofHeader()}`);
  response = await fetch(`${base}/v1/verify`, options); assert.equal(response.status, 503);
  response = await fetch(`${base}/v1/orders/${request.orderId}`, { headers: options.headers }); assert.equal(response.status, 409);
  assert.equal(calls.at(-1)[0], 'get'); assert.equal(calls.at(-1)[1].paymentProofHeader, undefined);
  response = await fetch(`${base}/v1/verify`, { ...options, body: JSON.stringify({ orderId: request.orderId, target: request.target, price: 1 }) }); assert.equal(response.status, 400);
  response = await fetch(`${base}/v1/verify`, { ...options, body: 'x'.repeat(32769) }); assert.equal(response.status, 400);
  response = await fetch(`${base}/v1/verify?secret=bad`, options); assert.equal(response.status, 400);
  response = await fetch(`${base}/v1/verify`, { ...options, headers: { 'content-type': 'application/json' } }); assert.equal(response.status, 401);
  assert(!JSON.stringify(logs).includes(request.recoverySecret)); assert(!JSON.stringify(logs).includes('private'));
});
