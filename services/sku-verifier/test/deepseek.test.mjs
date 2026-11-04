import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DeepSeekClient } from '../src/deepseek.mjs';

const result = {
  title: '商品规格', url: 'https://example.com/product', snippet: '检索摘要',
  summary: '较长摘要', content: '净含量 330 mL', date: null,
  authority: -1, rerank_score: 1.5, site_name: null, site_icon: null,
};
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const options = { apiKey: 'test-key', retryDelayMs: 0 };

test('search calls the official endpoint and preserves the full evidence response', async () => {
  const client = new DeepSeekClient({ ...options, fetchImpl: async (url, request) => {
    assert.equal(url, 'https://api.deepseek.com/v1/tools/search');
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, 'Bearer test-key');
    assert.equal(request.headers['Content-Type'], 'application/json');
    assert.ok(request.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(request.body), {
      query: '无糖茶 330mL', count: 5, need_content: true,
      ori_question: '核验包装与渠道报价', localization: '1.2.3.4',
    });
    return json({ results: [result] });
  } });
  assert.deepEqual(await client.search('无糖茶 330mL', {
    count: 5, originalQuestion: '核验包装与渠道报价', localization: '1.2.3.4',
  }), { results: [result] });
  assert.equal(client.usage.search.billableResponses, 1);
  assert.equal(client.usage.estimatedCostCny, 0.005);
  const copy = client.usage;
  copy.search.attempts = 100;
  assert.equal(client.usage.search.attempts, 1);
});

test('search defaults to body content and accepts Unicode code points at the limit', async () => {
  const client = new DeepSeekClient({ ...options, fetchImpl: async (_, request) => {
    assert.deepEqual(JSON.parse(request.body), { query: '茶'.repeat(127) + '🫖', count: 10, need_content: true });
    return json({ results: [] });
  } });
  assert.deepEqual(await client.search('茶'.repeat(127) + '🫖'), { results: [] });
  assert.equal(client.usage.search.successfulResponses, 1);
  assert.equal(client.usage.estimatedCostCny, 0);
});

test('explicit search options retain false and omit a null original question', async () => {
  const client = new DeepSeekClient({ ...options, fetchImpl: async (_, request) => {
    assert.deepEqual(JSON.parse(request.body), { query: '茶', count: 50, need_content: false });
    return json({ results: [{ ...result, content: '' }] });
  } });
  await client.search('茶', { count: 50, needContent: false, originalQuestion: null });
});

test('fetch sends a page URL and returns Markdown unchanged', async () => {
  const page = { title: '', content: '# 包装标签\n净含量 330 mL' };
  const client = new DeepSeekClient({ ...options, fetchImpl: async (url, request) => {
    assert.equal(url, 'https://api.deepseek.com/v1/tools/fetch');
    assert.deepEqual(JSON.parse(request.body), { url: result.url });
    return json(page);
  } });
  assert.deepEqual(await client.fetch(result.url), page);
  assert.equal(client.usage.fetch.billableResponses, 1);
});

test('empty fetch content does not accrue an estimated charge', async () => {
  const client = new DeepSeekClient({ ...options, fetchImpl: async () => json({ title: '', content: '' }) });
  await client.fetch(result.url);
  assert.equal(client.usage.estimatedCostCny, 0);
});

test('invalid input fails before any network request', async () => {
  const client = new DeepSeekClient({ ...options, fetchImpl: () => assert.fail('unexpected request') });
  for (const query of ['', '  ', '🫖'.repeat(129), null]) {
    await assert.rejects(client.search(query), { code: 'INVALID_INPUT' });
  }
  for (const settings of [{ count: 0 }, { count: 51 }, { count: 1.5 }, { needContent: 'yes' },
    { originalQuestion: ' ' }, { originalQuestion: '茶'.repeat(129) }, { localization: 123 }]) {
    await assert.rejects(client.search('茶', settings), { code: 'INVALID_INPUT' });
  }
  for (const url of ['', '/relative', 'file:///etc/hosts', 'https://user:password@example.com', 'https://example.com/' + 'a'.repeat(8192)]) {
    await assert.rejects(client.fetch(url), { code: 'INVALID_INPUT' });
  }
  assert.equal(client.usage.search.attempts + client.usage.fetch.attempts, 0);
});

for (const status of [400, 401, 402, 403, 404, 413]) {
  test(`HTTP ${status} is surfaced without retrying or leaking the response body`, async () => {
    const client = new DeepSeekClient({ ...options, fetchImpl: async () => json({ error: { message: 'test-key secret details' } }, status) });
    await assert.rejects(client.fetch(result.url), error => {
      assert.equal(error.code, 'HTTP_ERROR');
      assert.equal(error.status, status);
      assert.equal(error.retryable, false);
      assert.doesNotMatch(error.stack, /test-key|secret details/);
      return true;
    });
    assert.equal(client.usage.fetch.attempts, 1);
    assert.equal(client.usage.fetch.uncertainOutcomes, 0);
  });
}

for (const status of [408, 429, 500, 504]) {
  test(`HTTP ${status} retries within its limit and counts the successful response once`, async () => {
    let calls = 0;
    const client = new DeepSeekClient({ ...options, fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? json({}, status, { 'Retry-After': '0' }) : json({ results: [result] });
    } });
    await client.search('茶');
    assert.equal(calls, 2);
    assert.equal(client.usage.search.attempts, 2);
    assert.equal(client.usage.search.billableResponses, 1);
  });
}

test('repeated HTTP failures stop at the configured retry limit', async () => {
  const client = new DeepSeekClient({ ...options, fetchImpl: async () => json({}, 500) });
  await assert.rejects(client.search('茶'), { status: 500, retryable: true });
  assert.equal(client.usage.search.attempts, 3);
});

test('a long Retry-After is returned to the scheduler without an early retry', async () => {
  const client = new DeepSeekClient({ ...options, fetchImpl: async () => json({}, 429, { 'Retry-After': '120' }) });
  await assert.rejects(client.search('茶'), { status: 429 });
  assert.equal(client.usage.search.attempts, 1);
});

test('network failures are tracked as uncertain, bounded and redacted', async () => {
  const client = new DeepSeekClient({ ...options, maxRequests: 2, fetchImpl: async () => {
    throw new Error('transport leaked test-key');
  } });
  await assert.rejects(client.search('茶'), { code: 'REQUEST_BUDGET_EXCEEDED' });
  assert.equal(client.usage.search.uncertainOutcomes, 2);
  assert.equal(client.usage.estimatedCostCny, 0);
});

test('search and fetch share one request budget', async () => {
  const client = new DeepSeekClient({ ...options, maxRequests: 1, fetchImpl: async () => json({ results: [] }) });
  await client.search('茶');
  await assert.rejects(client.fetch(result.url), { code: 'REQUEST_BUDGET_EXCEEDED' });
  assert.equal(client.usage.fetch.attempts, 0);
});

test('concurrent operations reserve request budget before sending', async () => {
  let calls = 0;
  const client = new DeepSeekClient({ ...options, maxRequests: 1, fetchImpl: async () => {
    calls += 1;
    return json({ results: [] });
  } });
  const responses = await Promise.allSettled([client.search('茶'), client.fetch(result.url)]);
  assert.equal(responses[0].status, 'fulfilled');
  assert.equal(responses[1].reason.code, 'REQUEST_BUDGET_EXCEEDED');
  assert.equal(calls, 1);
});

test('network error messages never include raw transport details', async () => {
  const client = new DeepSeekClient({ ...options, maxRetries: 0, fetchImpl: async () => {
    throw new Error('Authorization: Bearer test-key');
  } });
  await assert.rejects(client.search('茶'), error => {
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.doesNotMatch(error.stack, /test-key|Authorization/);
    return true;
  });
});

test('an aborted error body does not hide the HTTP status', async () => {
  const client = new DeepSeekClient({ ...options, fetchImpl: async () => ({
    ok: false, status: 402, headers: new Headers(),
    body: { cancel: async () => { throw new Error('body already aborted'); } },
  }) });
  await assert.rejects(client.search('茶'), { status: 402, retryable: false });
});

test('invalid provider JSON or schema is not treated as an empty search result', async () => {
  for (const body of ['not json', '{}', '{"results":[null]}', '{"results":[{"url":"https://example.com"}]}']) {
    const client = new DeepSeekClient({ ...options, fetchImpl: async () => new Response(body) });
    await assert.rejects(client.search('茶'), { code: 'INVALID_RESPONSE' });
    assert.equal(client.usage.search.attempts, 1);
    assert.equal(client.usage.search.uncertainOutcomes, 1);
  }
});

test('caller cancellation does not send a new request or retry an in-flight one', async () => {
  const controller = new AbortController();
  const client = new DeepSeekClient({ ...options, fetchImpl: async () => {
    controller.abort();
    throw new Error('cancelled');
  } });
  await assert.rejects(client.search('茶', { signal: controller.signal }), { code: 'ABORTED' });
  await assert.rejects(client.search('茶', { signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(client.usage.search.attempts, 1);
});

test('timeout aborts the transport and returns a typed error', async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const client = new DeepSeekClient({ ...options, timeoutMs: 5, maxRetries: 0, fetchImpl: async (_, request) => {
      return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
    } });
    await assert.rejects(client.search('茶'), { code: 'TIMEOUT', retryable: true });
    assert.equal(client.usage.search.uncertainOutcomes, 1);
  } finally {
    clearInterval(keepAlive);
  }
});

test('CLI help and missing-key errors work without contacting the provider', () => {
  const script = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const env = { ...process.env, DEEPSEEK_API_KEY: '' };
  const help = spawnSync(process.execPath, [script, '--help'], { env, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  const missing = spawnSync(process.execPath, [script, 'search', '茶'], { env, encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).error.code, 'MISSING_API_KEY');
});
