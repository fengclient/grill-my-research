import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { AlipaySdk } from 'alipay-sdk';
import { AlipayPayments, createAlipay, parsePaymentProof } from '../src/alipay.mjs';
import { proofHeader } from './paid-fixtures.mjs';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const order = { order_id: 'a'.repeat(32), price_fen: 99, service_id: 'service', goods_name: 'SKU', currency: 'CNY', pay_before: '2026-11-06T01:00:00Z' };

test('strict bounded Payment-Proof parsing retains only current official fields', () => {
  assert.equal(parsePaymentProof(proofHeader()).client_session, 'buyer-private-session');
  for (const value of ['', '%%%=', 'e30=', proofHeader().replace(/=+$/, '') + '\n', 'A'.repeat(8193), Buffer.from(JSON.stringify({ protocol: { payment_proof: 'p'.repeat(64), trade_no: 'trade' } })).toString('base64')]) {
    assert.throws(() => parsePaymentProof(value), error => error.code === 'INVALID_PAYMENT_PROOF');
  }
});

test('merchant configuration fails closed and selects only official gateways', () => {
  assert.throws(() => createAlipay({ environment: 'production', appId: '123', privateKey: keys.privateKey }));
  assert.throws(() => createAlipay({ environment: 'https://attacker.invalid', appId: '123', privateKey: keys.privateKey, alipayPublicKey: keys.publicKey }));
  const adapter = createAlipay({ environment: 'production', appId: '123', privateKey: keys.privateKey, alipayPublicKey: keys.publicKey });
  assert.equal(adapter.sdk.config.gateway, 'https://openapi.alipay.com/gateway.do');
  assert.equal(adapter.sdk.config.camelcase, false);
});

test('actual SDK verifies signed precreate/verify fixture and rejects tampered or unsigned response', async t => {
  let tamper = false;
  let unsigned = false;
  let fixture = { code: '10000', active: true, amount: '0.99', out_trade_no: order.order_id, trade_no: 't'.repeat(32) };
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://localhost');
    const params = new URLSearchParams(Buffer.concat(chunks).toString());
    const method = url.searchParams.get('method') || params.get('method');
    received.push(JSON.parse(params.get('biz_content') || url.searchParams.get('biz_content')));
    const data = method.endsWith('precreate') ? { code: '10000', amt_pre_pay_id: 'amt_fixture' } : fixture;
    const serialized = JSON.stringify(data);
    const signature = sign('RSA-SHA256', Buffer.from(serialized), keys.privateKey).toString('base64');
    const responseData = tamper ? { ...data, amount: '0.01' } : data;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ [`${method.replaceAll('.', '_')}_response`]: responseData, ...(unsigned ? {} : { sign: signature }) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const sdk = new AlipaySdk({ appId: '123', privateKey: keys.privateKey, keyType: 'PKCS8', alipayPublicKey: keys.publicKey,
    camelcase: false, gateway: `http://127.0.0.1:${server.address().port}/gateway.do` });
  const adapter = new AlipayPayments(sdk);
  assert.equal(await adapter.precreate(order), 'amt_fixture');
  assert.deepEqual(received[0], { out_trade_no: order.order_id, amount: '0.99', currency: 'CNY', goods_name: 'SKU', service_id: 'service', pay_before: '2026-11-06T01:00:00.000Z' });
  const proof = parsePaymentProof(proofHeader());
  assert.equal(await adapter.verify(order, proof), proof.trade_no);
  assert.deepEqual(received[1], proof);
  for (const bad of [{ active: false }, { active: 'true' }, { amount: '0.9901' }, { amount: '0.98' }, { amount: 0.99 }, { out_trade_no: 'wrong' }, { trade_no: 'other' }]) {
    const original = fixture; fixture = { ...fixture, ...bad };
    await assert.rejects(adapter.verify(order, proof), error => error.code === 'PAYMENT_INVALID');
    fixture = original;
  }
  tamper = true;
  await assert.rejects(adapter.verify(order, proof), error => error.code === 'PAYMENT_PROVIDER_UNAVAILABLE');
  tamper = false; unsigned = true;
  await assert.rejects(adapter.verify(order, proof), error => error.code === 'PAYMENT_PROVIDER_UNAVAILABLE');
});
