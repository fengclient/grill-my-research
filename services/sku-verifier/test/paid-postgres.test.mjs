import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { PostgresPaidStore } from '../src/paid-store.mjs';
import { createPaidVerifier } from '../src/paid-verifier.mjs';
import { verifySku } from '../src/verify.mjs';
import { createPaidServer } from '../src/paid-server.mjs';
import { newRequest, proofHeader, payments, reportFor, largeReport } from './paid-fixtures.mjs';

const databaseUrl = process.env.SKU_TEST_DATABASE_URL;
test('real PostgreSQL durable payment and execution invariants', { skip: !databaseUrl && 'Set explicit SKU_TEST_DATABASE_URL to a disposable test database.' }, async t => {
  assert.match(new URL(databaseUrl).pathname, /test/i, 'Test URL must identify a disposable test database.');
  const schema = `sku_test_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const poolA = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const poolB = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  t.after(async () => { await Promise.all([poolA.end(), poolB.end()]); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const migration = await readFile(new URL('../migrations/001-paid-orders.sql', import.meta.url), 'utf8');
  await poolA.query(migration); await poolA.query(migration);
  const storeA = new PostgresPaidStore({ pool: poolA });
  const storeB = new PostgresPaidStore({ pool: poolB });
  const makeService = (store = storeA, extra = {}) => createPaidVerifier({ store, alipay: payments, verify: async target => reportFor(target), serviceId: 'service', ...extra });
  const clear = () => poolA.query('TRUNCATE paid_orders');

  await t.test('one frozen bill survives adapter crash and recovery never precreates', async () => {
    await clear();
    const request = newRequest();
    let attempts = 0;
    const seen = [];
    const service = makeService(storeA, { alipay: { ...payments, precreate: async order => {
      attempts++; seen.push({ amount: order.price_fen, orderId: order.order_id, target: order.target, expiry: order.pay_before });
      if (attempts === 1) throw Error('lost precreate response');
      return 'amt_recovered';
    } } });
    await assert.rejects(service.request(request));
    await assert.rejects(service.recover(request), error => error.code === 'PAYMENT_NOT_READY');
    assert.equal(attempts, 1);
    const quote = await service.request(request);
    assert.equal(quote.paymentLink, 'amt_recovered'); assert.equal(quote.amount, '0.99');
    assert.deepEqual(seen[0], seen[1]);
    assert.deepEqual(await makeService(storeB, { priceFen: 5000 }).request(request), quote);
    await assert.rejects(poolA.query('UPDATE paid_orders SET price_fen=1 WHERE order_id=$1', [request.orderId]), /immutable paid order/);
    await assert.rejects(service.request({ ...request, recoverySecret: randomBytes(32).toString('base64url') }), error => error.code === 'UNAUTHORIZED');
    await assert.rejects(service.request({ ...request, target: { ...request.target, productName: 'Other' } }), error => error.code === 'ORDER_TARGET_MISMATCH');
    await assert.rejects(service.recover(newRequest()), error => error.code === 'ORDER_NOT_FOUND');
  });

  await t.test('two replicas race one order, compute once and recover exact committed result after lost delivery', async () => {
    await clear();
    const request = newRequest();
    let runs = 0;
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const verify = async target => { runs++; await barrier; return reportFor(target); };
    const first = makeService(storeA, { verify });
    const second = makeService(storeB, { verify });
    await first.request(request);
    const executeA = first.request({ ...request, paymentProofHeader: proofHeader() });
    const executeB = second.request({ ...request, paymentProofHeader: proofHeader() });
    let running;
    for (let n = 0; n < 100; n++) {
      running = await second.recover(request);
      if (running.kind === 'running') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(running.kind, 'running');
    release();
    const results = await Promise.all([executeA, executeB]);
    assert.equal(runs, 1); assert(results.some(result => result.kind === 'report'));
    const recovered = await makeService(storeB).recover(request);
    assert.equal(recovered.kind, 'report');
    assert.deepEqual(recovered, results.find(result => result.kind === 'report'));
    assert.deepEqual(await second.request({ ...request, paymentProofHeader: proofHeader() }), recovered);
    assert.equal(runs, 1);
    const row = await storeA.get(request.orderId);
    assert.equal(row.trade_no, 't'.repeat(32));
    const serializedRow = JSON.stringify(row);
    assert(!serializedRow.includes(request.recoverySecret)); assert(!serializedRow.includes('buyer-private-session')); assert(!serializedRow.includes('p'.repeat(64)));
    await assert.rejects(poolA.query('UPDATE paid_orders SET markdown=$2 WHERE order_id=$1', [request.orderId, 'changed']), /immutable paid order/);
  });

  await t.test('HTTP disconnect does not abort paid research and GET recovers its committed report', async () => {
    await clear();
    const request = newRequest();
    let release;
    let started;
    const running = new Promise(resolve => { started = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    let signal;
    const service = makeService(storeA, { verify: async (target, options) => {
      signal = options.signal; started(); await barrier; return reportFor(target);
    } });
    await service.request(request);
    const server = createPaidServer({ service });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const controller = new AbortController();
      const base = `http://127.0.0.1:${server.address().port}`;
      const response = fetch(`${base}/v1/verify`, { method: 'POST', signal: controller.signal,
        headers: { authorization: `Bearer ${request.recoverySecret}`, 'content-type': 'application/json', 'Payment-Proof': proofHeader() },
        body: JSON.stringify({ orderId: request.orderId, target: request.target }) }).catch(error => error);
      await running; controller.abort(); await response;
      assert.equal(signal.aborted, false);
      release();
      let recovered;
      for (let n = 0; n < 100; n++) {
        const read = await fetch(`${base}/v1/orders/${request.orderId}`, { headers: { authorization: `Bearer ${request.recoverySecret}` } });
        recovered = await read.json();
        if (recovered.kind === 'report') break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(recovered.kind, 'report'); assert.equal(signal.aborted, false);
    } finally { release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });

  await t.test('concurrent verified claim takes precedence over a late payment-provider rejection', async () => {
    await clear();
    const request = newRequest();
    let release;
    let started;
    const checking = new Promise(resolve => { started = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const service = makeService(storeA, { alipay: { ...payments, verify: async () => {
      started(); await barrier; throw Error('proof already checked concurrently');
    } } });
    await service.request(request);
    const execution = service.request({ ...request, paymentProofHeader: proofHeader() });
    await checking;
    const row = await storeB.get(request.orderId);
    await storeB.claim({ orderId: request.orderId, capabilityHash: row.capability_hash, targetHash: row.target_hash,
      tradeNo: 't'.repeat(32), claimToken: 'competitor', started: new Date().toISOString(), deadline: new Date(Date.now() + 10000).toISOString() });
    release();
    assert.equal((await execution).kind, 'running');
  });

  await t.test('one trade cannot fund two orders across independent connections', async () => {
    await clear();
    const one = newRequest(); const two = newRequest();
    let runs = 0;
    const serviceA = makeService(storeA, { verify: async target => { runs++; return reportFor(target); } });
    const serviceB = makeService(storeB, { verify: async target => { runs++; return reportFor(target); } });
    await Promise.all([serviceA.request(one), serviceB.request(two)]);
    const results = await Promise.allSettled([serviceA.request({ ...one, paymentProofHeader: proofHeader() }), serviceB.request({ ...two, paymentProofHeader: proofHeader() })]);
    assert.equal(runs, 1);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'PAYMENT_INVALID');
  });

  await t.test('expired unpaid quote stops billing but already-paid valid proof still executes', async () => {
    await clear();
    let clock = Date.now(); let runs = 0;
    const service = makeService(storeA, { now: () => clock, quoteTtlMs: 1000, verify: async target => { runs++; return reportFor(target); } });
    const request = newRequest(); await service.request(request); clock += 2000;
    await assert.rejects(service.request(request), error => error.code === 'ORDER_EXPIRED');
    await assert.rejects(service.recover(request), error => error.code === 'ORDER_EXPIRED');
    assert.equal((await service.request({ ...request, paymentProofHeader: proofHeader() })).kind, 'report');
    assert.equal(runs, 1);
  });

  await t.test('crash after claim is never reclaimed, recovery is read-only, late result may commit', async () => {
    await clear();
    let clock = Date.now();
    const request = newRequest(); const service = makeService(storeA, { now: () => clock, graceMs: 10 });
    await service.request(request);
    const row = await storeA.get(request.orderId);
    await storeA.claim({ orderId: request.orderId, capabilityHash: row.capability_hash, targetHash: row.target_hash,
      tradeNo: 't'.repeat(32), claimToken: 'claim', started: new Date(clock).toISOString(), deadline: new Date(clock + 10).toISOString() });
    clock += 100;
    assert.equal((await service.recover(request)).kind, 'needs_review');
    assert.equal((await service.request({ ...request, paymentProofHeader: proofHeader() })).kind, 'needs_review');
    assert.equal((await storeB.get(request.orderId)).state, 'running');
    const report = reportFor(row.target);
    await storeB.finish(request.orderId, 'claim', report, 'exact late markdown');
    assert.deepEqual((await service.recover(request)).report, report);
    assert.equal((await service.recover(request)).markdown, 'exact late markdown');
  });

  await t.test('failed persistence never repeats research and ambiguous committed finish recovers', async () => {
    await clear();
    const request = newRequest(); let runs = 0;
    const failedStore = Object.create(storeA);
    failedStore.finish = async () => { throw Error('database lost after compute'); };
    const service = makeService(failedStore, { verify: async target => { runs++; return reportFor(target); } });
    await service.request(request);
    await assert.rejects(service.request({ ...request, paymentProofHeader: proofHeader() }), error => error.code === 'ORDER_OUTCOME_UNCERTAIN');
    assert.equal((await service.recover(request)).kind, 'needs_review');
    assert.equal((await service.request({ ...request, paymentProofHeader: proofHeader() })).kind, 'needs_review');
    assert.equal(runs, 1);
    const next = newRequest(); let commits = 0;
    const uncertainStore = Object.create(storeA);
    uncertainStore.finish = async (...args) => { const row = await storeA.finish(...args); commits++; if (commits === 1) throw Error('commit acknowledgement lost'); return row; };
    const nextService = makeService(uncertainStore);
    await nextService.request(next);
    const result = await nextService.request({ ...next, paymentProofHeader: proofHeader('u'.repeat(32)) });
    assert.equal(result.kind, 'report'); assert.equal(commits, 2);
    assert.deepEqual(await makeService(storeB).recover(next), result);
  });

  await t.test('failed and exhausted verifier reports are durable paid outcomes', async () => {
    await clear();
    for (const [index, status] of ['failed','budget_exhausted'].entries()) {
      const request = newRequest();
      const service = makeService(storeA, { verify: async target => reportFor(target, status) });
      await service.request(request);
      const result = await service.request({ ...request, paymentProofHeader: proofHeader(String(index).repeat(32)) });
      assert.equal(result.kind, 'report'); assert.equal(result.report.status, status);
      assert.deepEqual(await makeService(storeB).recover(request), result);
    }
  });

  await t.test('oversized completed report is bounded and committed durably instead of entering needs_review', async () => {
    await clear();
    const request = newRequest();
    const original = largeReport();
    let runs = 0;
    const service = makeService(storeA, { verify: async () => { runs++; return original; } });
    await service.request(request);
    const delivered = await service.request({ ...request, paymentProofHeader: proofHeader() });
    assert.equal(delivered.kind, 'report'); assert.equal(delivered.report.status, 'completed');
    assert.equal(delivered.report.delivery.truncated, true);
    assert.deepEqual(delivered.report.verification, original.verification);
    assert.deepEqual(delivered.report.trace, original.trace);
    assert.deepEqual(await makeService(storeB).recover(request), delivered);
    const stored = await storeB.get(request.orderId);
    assert.equal(stored.state, 'finished');
    const sizes = (await poolB.query('SELECT octet_length(report::text) AS report_bytes,octet_length(markdown) AS markdown_bytes FROM paid_orders WHERE order_id=$1', [request.orderId])).rows[0];
    assert(sizes.report_bytes <= 2097152); assert(sizes.markdown_bytes <= 2097152);
    assert.equal(runs, 1);
  });

  await t.test('large retained citation payload fits PostgreSQL jsonb formatting and keeps its conflict witnesses', async () => {
    await clear();
    const request = newRequest();
    const original = reportFor(request.target);
    original.verification.fields[0].status = 'review_variants';
    original.verification.fields[0].statements = Array.from({ length: 900 }, (_, index) => ({ sourceId: 's1', quote: `${index}`.padEnd(600, '\u0001') }));
    const service = makeService(storeA, { verify: async () => original });
    await service.request(request);
    const delivered = await service.request({ ...request, paymentProofHeader: proofHeader() });
    assert.equal(delivered.kind, 'report');
    const field = delivered.report.verification.fields[0];
    assert.equal(field.status, 'review_variants');
    assert.equal(field.statements.length + field.delivery.omittedStatements, 900);
    assert.deepEqual(await makeService(storeB).recover(request), delivered);
    assert.equal((await storeB.get(request.orderId)).state, 'finished');
  });

  await t.test('real verifier Unicode in raw sources or retained quotes becomes a durable explicit failed report', async () => {
    for (const invalid of ['\u0000', '\ud800', '\udc00']) {
      for (const quoted of [false, true]) {
        await clear();
        const request = newRequest();
        const content = `Test Tea 500ml\nwater${invalid}tea`;
        const actions = [{ action: 'search', query: 'official' }, { action: 'search', query: 'retail' },
          { action: 'finish', candidates: [{ sourceId: 's1', productLines: [1, quoted ? 2 : 1], facts: quoted ? [{ field: 'ingredients', lines: [2, 2] }] : [] }] }];
        let original;
        let runs = 0;
        const service = makeService(storeA, { verify: async target => {
          runs++;
          original = await verifySku(target, { client: { usage: {}, search: async () => ({ results: [{ title: 'Tea', url: 'https://example.com/tea', content }] }) },
            model: { usage: {}, next: async () => actions.shift() }, maxSteps: 3 });
          return original;
        } });
        await service.request(request);
        const delivered = await service.request({ ...request, paymentProofHeader: proofHeader() });
        assert.equal(original.status, 'completed');
        assert.equal(original.verification.fields[0].statements.length, quoted ? 1 : 0);
        assert.equal(delivered.kind, 'report'); assert.equal(delivered.report.status, 'failed');
        assert.equal(delivered.report.failure.code, 'REPORT_UNSUPPORTED_UNICODE');
        assert.equal(delivered.report.delivery.omitted.sources, 1);
        assert.equal(delivered.report.delivery.omitted.statements, quoted ? 1 : 0);
        assert.equal(delivered.report.verification.matchedSourceCount, 0);
        assert.deepEqual(await makeService(storeB).recover(request), delivered);
        assert.equal((await storeB.get(request.orderId)).state, 'finished'); assert.equal(runs, 1);
      }
    }
  });

  await t.test('invalid proof and payment provider outage prevent claim and research', async () => {
    await clear();
    const request = newRequest(); let runs = 0;
    const service = makeService(storeA, { alipay: { ...payments, verify: async () => { throw Error('provider unavailable'); } }, verify: async target => { runs++; return reportFor(target); } });
    await service.request(request);
    await assert.rejects(service.request({ ...request, paymentProofHeader: 'invalid' }), error => error.code === 'INVALID_PAYMENT_PROOF');
    await assert.rejects(service.request({ ...request, paymentProofHeader: proofHeader() }));
    assert.equal((await storeA.get(request.orderId)).state, 'awaiting_payment'); assert.equal(runs, 0);
  });
});
