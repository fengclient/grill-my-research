import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { PostgresPaidStore } from '../src/paid-store.mjs';
import { createPaidVerifier } from '../src/paid-verifier.mjs';
import { newRequest, payments, reportFor, proofHeader } from './paid-fixtures.mjs';

const databaseUrl = process.env.SKU_TEST_DATABASE_URL;
test('quote rate-limit configuration is bounded', () => {
  for (const quoteLimits of [{ perMinute: 0, perDay: 1 }, { perMinute: 1001, perDay: 1 }, { perMinute: 1.5, perDay: 1 }, { perMinute: 1, perDay: 0 }, { perMinute: 1, perDay: 100001 }, {}]) {
    assert.throws(() => new PostgresPaidStore({ pool: {}, quoteLimits }));
  }
  assert.deepEqual(new PostgresPaidStore({ pool: {} }).quoteLimits, { perMinute: 20, perDay: 200 });
});

test('rollback failure destroys the connection while preserving the original admission error', async () => {
  for (const failedRollback of [false, true]) {
    const original = new Error('admission query failed');
    const rollback = new Error('rollback timed out');
    const released = [];
    const client = {
      query: async sql => {
        if (sql.startsWith('SELECT * FROM paid_orders')) throw original;
        if (sql === 'ROLLBACK' && failedRollback) throw rollback;
        return { rows: [] };
      },
      release: (...args) => released.push(args),
    };
    const store = new PostgresPaidStore({ pool: { connect: async () => client } });
    await assert.rejects(store.create({ orderId: 'a'.repeat(32) }), error => error === original);
    assert.deepEqual(released, failedRollback ? [[rollback]] : [[]]);
  }
});

test('global PostgreSQL quote admission is atomic and existing orders bypass full quotas', { skip: !databaseUrl && 'Set explicit SKU_TEST_DATABASE_URL to a disposable test database.' }, async t => {
  assert.match(new URL(databaseUrl).pathname, /test/i);
  const schema = `sku_rate_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const poolA = new pg.Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
  const poolB = new pg.Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
  t.after(async () => { await Promise.all([poolA.end(), poolB.end()]); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  for (const migration of ['001-paid-orders.sql','002-quote-rate-limit.sql']) await poolA.query(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  await poolA.query(await readFile(new URL('../migrations/002-quote-rate-limit.sql', import.meta.url), 'utf8'));
  const service = (pool, quoteLimits) => createPaidVerifier({ store: new PostgresPaidStore({ pool, quoteLimits }), alipay: payments, verify: async target => reportFor(target), serviceId: 'service' });
  const clear = () => poolA.query('TRUNCATE paid_orders');
  const seed = (id, age) => poolA.query(`INSERT INTO paid_orders (order_id,capability_hash,target,target_hash,price_fen,service_id,goods_name,pay_before,created_at)
    VALUES ($1,'capability','{}','target',99,'service','SKU',statement_timestamp()+interval '30 minutes',statement_timestamp()-$2::interval)`, [id.repeat(32), age]);

  await t.test('different replicas cannot overshoot a shared minute limit and rejected transactions release clients', async () => {
    await clear();
    const first = service(poolA, { perMinute: 2, perDay: 10 });
    const second = service(poolB, { perMinute: 2, perDay: 10 });
    const requests = Array.from({ length: 8 }, () => newRequest());
    const results = await Promise.allSettled(requests.map((request, index) => (index % 2 ? first : second).request(request)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
    for (const result of results.filter(result => result.status === 'rejected')) {
      assert.equal(result.reason.status, 429); assert.equal(result.reason.code, 'QUOTE_RATE_LIMITED');
    }
    assert.equal(Number((await poolA.query('SELECT count(*) FROM paid_orders')).rows[0].count), 2);
    const existing = requests[results.findIndex(result => result.status === 'fulfilled')];
    const quote = await first.request(existing);
    assert.deepEqual(await second.request(existing), quote);
    assert.deepEqual(await second.recover(existing), quote);
    const delivered = await first.request({ ...existing, paymentProofHeader: proofHeader() });
    assert.equal(delivered.kind, 'report');
    assert.deepEqual(await second.recover(existing), delivered);
    assert.equal(poolA.waitingCount + poolB.waitingCount, 0);
  });

  await t.test('rolling day includes earlier minute orders and excludes older days', async () => {
    await clear();
    await seed('a', '61 seconds');
    await seed('b', '23 hours 59 minutes');
    await seed('c', '24 hours 1 minute');
    const constrained = service(poolA, { perMinute: 1, perDay: 2 });
    await assert.rejects(constrained.request(newRequest()), error => error.code === 'QUOTE_RATE_LIMITED');
    assert.equal(Number((await poolB.query('SELECT count(*) FROM paid_orders')).rows[0].count), 3);
    const allowsOne = service(poolB, { perMinute: 1, perDay: 3 });
    assert.equal((await allowsOne.request(newRequest())).kind, 'payment_required');
    await assert.rejects(allowsOne.request(newRequest()), error => error.code === 'QUOTE_RATE_LIMITED');
  });

  await t.test('concurrent retries of the same new order consume one slot', async () => {
    await clear();
    const request = newRequest();
    const first = service(poolA, { perMinute: 1, perDay: 1 });
    const second = service(poolB, { perMinute: 1, perDay: 1 });
    const quotes = await Promise.all([first.request(request), second.request(request)]);
    assert.deepEqual(quotes[0], quotes[1]);
    assert.equal(Number((await poolA.query('SELECT count(*) FROM paid_orders')).rows[0].count), 1);
    await assert.rejects(second.request(newRequest()), error => error.code === 'QUOTE_RATE_LIMITED');
    assert.deepEqual(await first.request(request), quotes[0]);
  });

  await t.test('a failed insertion rolls back quota reservation and releases the advisory lock', async () => {
    await clear();
    const first = new PostgresPaidStore({ pool: poolA, quoteLimits: { perMinute: 1, perDay: 1 } });
    await assert.rejects(first.create({ orderId: 'invalid', capabilityHash: 'cap', target: {}, targetHash: 'target', priceFen: 99,
      serviceId: 'service', goodsName: 'SKU', payBefore: new Date(Date.now() + 60000).toISOString() }));
    assert.equal((await service(poolB, { perMinute: 1, perDay: 1 }).request(newRequest())).kind, 'payment_required');
  });
});
