import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createCloudServer, MAX_BODY_BYTES } from '../src/cloud.mjs';
import { verifySku } from '../src/verify.mjs';

const token = 'test-worker-token-with-at-least-32-characters';
const target = { brand: '示例茶', productName: '茉莉茶', netQuantity: { value: 500, unit: 'mL' },
  version: null, packageForm: null, officialDomains: ['example.com'] };
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const post = { method: 'POST', body: JSON.stringify(target) };

async function serve(t, options = {}) {
  const server = createCloudServer({ token, log: () => {}, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.stop(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return (path, options = {}) => fetch(base + path, { headers, ...options });
}

async function realRunner(input, { signal } = {}) {
  let step = 0;
  const content = '示例茶 茉莉茶 500mL\n配料：水、茉莉茶';
  return verifySku(input, { signal,
    client: { usage: {}, search: async () => ({ results: [{ url: 'https://example.com/tea', title: '茶', content }] }) },
    model: { usage: {}, next: async () => ++step < 3 ? { action: 'search', query: `产品 ${step}` }
      : { action: 'finish', candidates: [{ sourceId: 's1', productLines: [1, 2], facts: [{ field: 'ingredients', lines: [2, 2] }] }] } },
  });
}

test('HTTP verification returns the real runner report directly as JSON or Markdown', async t => {
  const call = await serve(t, { verify: realRunner });
  const response = await call('/verify', post);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const report = await response.json();
  assert.equal(report.status, 'completed');
  assert.equal(report.verification.matchedSourceCount, 1);
  assert.equal(report.verification.fields.find(row => row.field === 'ingredients').status, 'source_supported');
  const markdown = await call('/verify?format=markdown', post);
  assert.match(markdown.headers.get('content-type'), /text\/markdown/);
  assert.match(await markdown.text(), /配料：水、茉莉茶/);
});

test('invalid, unauthorized and oversized requests never call the paid runner', async t => {
  const call = await serve(t, { verify: () => assert.fail('must not call paid provider') });
  assert.equal((await call('/verify', { ...post, headers: {} })).status, 401);
  assert.equal((await call('/verify', { ...post, body: '{broken' })).status, 400);
  assert.equal((await call('/verify', { ...post, body: '{}' })).status, 400);
  assert.equal((await call('/verify', { ...post, body: 'x'.repeat(MAX_BODY_BYTES + 1) })).status, 413);
  assert.equal((await call('/verify', { ...post, headers: { authorization: `Bearer ${token}` } })).status, 415);
  assert.equal((await call('/other', post)).status, 404);
  assert.deepEqual(await (await call('/health')).json(), { status: 'ok' });
});

test('one in-flight verification per instance rejects concurrent work before paid calls', async t => {
  let release;
  let started;
  const running = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const call = await serve(t, { verify: async (...args) => {
    calls += 1; started(); await gate; return realRunner(...args);
  } });
  const first = call('/verify', post);
  await running;
  const busy = await call('/verify', post);
  assert.equal(busy.status, 429);
  assert.deepEqual(await busy.json(), { error: 'INSTANCE_BUSY' });
  assert.equal(calls, 1);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await call('/verify', post)).status, 200);
  assert.equal(calls, 2, 'a new explicit request runs again; no global idempotency is claimed');
});

test('provider failure returns a non-success response with the collected report', async t => {
  const report = { ...await realRunner(target), status: 'failed', failure: { code: 'MODEL_HTTP_ERROR' } };
  const call = await serve(t, { verify: async () => report });
  const response = await call('/verify', post);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), report);
});

test('unexpected errors are redacted and are never retried automatically', async t => {
  let calls = 0;
  const logs = [];
  const call = await serve(t, { verify: async () => { calls += 1; throw new Error('SECRET'); }, log: row => logs.push(row) });
  const response = await call('/verify', post);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'VERIFICATION_ERROR' });
  assert.ok(!JSON.stringify(logs).includes('SECRET'));
  assert.equal(calls, 1);
});

test('deadline aborts provider work and returns the failed report', async t => {
  const call = await serve(t, { timeoutMs: 10, verify: async (input, { signal }) => {
    await once(signal, 'abort');
    return { ...await realRunner(input), status: 'failed', failure: { code: 'ABORTED' } };
  } });
  const response = await call('/verify', post);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).failure.code, 'ABORTED');
});

test('client disconnect cancels the running provider operation', async t => {
  let started;
  let observedAbort;
  const running = new Promise(resolve => { started = resolve; });
  const aborted = new Promise(resolve => { observedAbort = resolve; });
  const call = await serve(t, { verify: async (input, { signal }) => {
    started(); await once(signal, 'abort'); observedAbort(); return realRunner(input);
  } });
  const controller = new AbortController();
  const request = call('/verify', { ...post, signal: controller.signal });
  await running;
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  await aborted;
});
