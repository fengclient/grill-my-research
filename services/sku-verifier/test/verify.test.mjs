import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.mjs';
import { DeepSeekError } from '../src/deepseek.mjs';
import { DeepSeekModel } from '../src/model.mjs';
import { materializeCandidates, validateTarget, verifyCandidates } from '../src/evidence.mjs';
import { verifySku } from '../src/verify.mjs';

const target = { brand: '示例茶', productName: '茉莉茶', netQuantity: { value: 500, unit: 'mL' }, version: null, packageForm: null, officialDomains: ['example.com'] };
const content = '示例茶茉莉茶\n净含量：500mL\n配料：水、茉莉茶\n保质期：9个月';
const evidence = { sourceId: 's1', productQuote: content, facts: [{ field: 'ingredients', quote: '配料：水、茉莉茶' }, { field: 'shelfLife', quote: '保质期：9个月' }] };
const sources = [{ id: 's1', url: 'https://example.com/tea', content }];
const finish = { action: 'finish', candidates: [{ sourceId: 's1', productLines: [1, 4], facts: [
  { field: 'ingredients', lines: [3, 3] }, { field: 'shelfLife', lines: [4, 4] },
] }] };

function harness(actions) {
  let index = 0;
  const calls = [];
  return {
    calls,
    client: {
      usage: { estimatedCostCny: 0.01 },
      search: async query => {
        calls.push(['search', query]);
        return { results: [{ title: '产品', url: 'https://example.com/tea', content, date: null }] };
      },
      fetch: async url => { calls.push(['fetch', url]); return { title: '产品', content }; },
    },
    model: {
      usage: { model: 'test', promptTokens: 10, completionTokens: 20 },
      next: async (system, state) => {
        assert.match(system, /不可信数据/);
        assert.deepEqual(state.target, target);
        return actions[index++];
      },
    },
  };
}

test('CLI writes source-backed JSON and Markdown through the normal verification entry point', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sku-verifier-'));
  try {
    const input = join(directory, 'target.json');
    const output = join(directory, 'result');
    await writeFile(input, JSON.stringify(target));
    const deps = harness([{ action: 'search', query: '示例茶 官方' }, { action: 'search', query: '示例茶 零售' }, { action: 'fetch', sourceId: 's1' }, finish]);
    const stdout = [];
    assert.equal(await main(['verify', input, output], { ...deps, stdout: text => stdout.push(text) }), 0);
    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    assert.equal(report.status, 'completed');
    assert.equal(report.verification.identityStatus, 'requested_identity_supported');
    assert.equal(report.verification.fields.find(field => field.field === 'ingredients').status, 'source_supported');
    assert.equal(report.verification.fields.find(field => field.field === 'nutrition').status, 'missing');
    assert.match(report.sources[0].contentSha256, /^[0-9a-f]{64}$/);
    assert.match(await readFile(join(output, 'report.md'), 'utf8'), /配料：水、茉莉茶/);
    assert.ok(JSON.parse(stdout[0]).directory.endsWith('/result'));
    const count = deps.calls.length;
    assert.equal(await main(['verify', input, output], { ...deps, stderr: () => {} }), 1);
    assert.equal(deps.calls.length, count, 'existing output must fail before paid calls');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI persists an explicit failed report when the provider fails after collecting sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sku-failed-'));
  try {
    const input = join(directory, 'target.json');
    const output = join(directory, 'result');
    await writeFile(input, JSON.stringify(target));
    const deps = harness([{ action: 'search', query: '官方' }]);
    let turns = 0;
    deps.model.next = async () => {
      turns += 1;
      if (turns === 1) return { action: 'search', query: '官方' };
      throw new DeepSeekError('MODEL_HTTP_ERROR', 'Model returned HTTP 402.', { status: 402 });
    };
    assert.equal(await main(['verify', input, output], { ...deps, stdout: () => {} }), 1);
    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    assert.equal(report.status, 'failed');
    assert.equal(report.sources.length, 1);
    assert.equal(report.failure.status, 402);
    assert.equal(report.verification.identityStatus, 'not_established');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('quantity normalization accepts 0.5L and rejects other or mixed capacities', () => {
  for (const [quote, expected] of [
    [content.replace('500mL', '0.5 L'), 'requested_identity_supported'],
    [content.replace('500mL', '900mL'), 'not_established'],
    [content + '\n另有900mL', 'not_established'],
    [content + '\n每100mL含糖0g', 'requested_identity_supported'],
    [content.replace('500mL', '５００ｍＬ'), 'requested_identity_supported'],
    [content.replace('500mL', '251-500mL'), 'not_established'],
  ]) {
    const result = verifyCandidates(target, [{ ...sources[0], content: quote }], [{ ...evidence, productQuote: quote }]);
    assert.equal(result.identityStatus, expected);
  }
});

test('wrong flavor, brand, specified packaging and specified version are rejected', () => {
  for (const changed of [
    { ...target, brand: '别的品牌' }, { ...target, productName: '乌龙茶' },
    { ...target, packageForm: '纸盒' }, { ...target, version: '2025版' },
  ]) assert.equal(verifyCandidates(changed, sources, [evidence]).identityStatus, 'not_established');
});

test('title or summary and invented quotes cannot establish identity', () => {
  assert.equal(verifyCandidates(target, [{ ...sources[0], title: content, content: '' }], [evidence]).identityStatus, 'not_established');
  assert.equal(verifyCandidates(target, sources, [{ ...evidence, productQuote: content + '\n虚构' }]).identityStatus, 'not_established');
  assert.equal(verifyCandidates(target, sources, [{ ...evidence, sourceId: 'invented' }]).rejected[0].reason, '引用了未知来源');
});

test('facts outside the matched context and invented nutrient values are rejected', () => {
  const result = verifyCandidates(target, [{ ...sources[0], content: content + '\n其他产品含糖12g' }], [{
    ...evidence, facts: [{ field: 'nutrition', quote: '其他产品含糖12g' }, { field: 'nutrition', quote: '含糖0g' }],
  }]);
  assert.equal(result.fields.find(field => field.field === 'nutrition').status, 'missing');
  assert.equal(result.rejected.length, 2);
});

test('different source formulations are retained for review', () => {
  const other = content.replace('水、茉莉茶', '水、茉莉茶、维生素C');
  const result = verifyCandidates(target, [...sources, { id: 's2', url: 'https://shop.example/tea', content: other }], [
    evidence, { sourceId: 's2', productQuote: other, facts: [{ field: 'ingredients', quote: '配料：水、茉莉茶、维生素C' }] },
  ]);
  assert.equal(result.fields.find(field => field.field === 'ingredients').status, 'review_variants');
  assert.equal(result.matchedDomainCount, 2);
});

test('the same shelf life with different field punctuation is not a conflict', () => {
  const other = content.replace('保质期：9个月', '保质期\n9个月');
  const result = verifyCandidates(target, [...sources, { id: 's2', url: 'https://shop.example/tea', content: other }], [
    evidence, { sourceId: 's2', productQuote: other, facts: [{ field: 'shelfLife', quote: '保质期\n9个月' }] },
  ]);
  assert.equal(result.fields.find(field => field.field === 'shelfLife').status, 'source_supported');
});

test('official source attribution is bound to configured domains, not page titles', async () => {
  const deps = harness([{ action: 'search', query: '官方' }, { action: 'search', query: '零售' }, finish]);
  deps.client.search = async () => ({ results: [{ title: '官方旗舰店', url: 'https://example.com.attacker.test/product', content }] });
  const report = await verifySku(target, deps);
  assert.equal(report.sources[0].kind, 'other');
  assert.equal(report.verification.officialMatchedSourceCount, 0);
});

test('the Agent can repair rejected fact context using validation feedback', async () => {
  const invalid = { ...finish, candidates: [{ ...finish.candidates[0], productLines: [1, 2] }] };
  const deps = harness([{ action: 'search', query: '官方' }, { action: 'search', query: '零售' }, invalid, finish]);
  const report = await verifySku(target, deps);
  assert.equal(report.trace[2].rejected.length, 2);
  assert.equal(report.verification.rejected.length, 0);
  assert.equal(report.verification.fields.find(field => field.field === 'ingredients').status, 'source_supported');
});

test('fetching an empty body retains usable prior search content', async () => {
  const deps = harness([{ action: 'search', query: '官方' }, { action: 'search', query: '零售' }, { action: 'fetch', sourceId: 's1' }, finish]);
  deps.client.fetch = async () => ({ title: '', content: '' });
  const report = await verifySku(target, deps);
  assert.equal(report.sources[0].content, content);
  assert.equal(report.sources[0].retrieval, 'search');
});

test('line references materialize source text and reject out-of-range or invented quotes', () => {
  const raw = structuredClone(finish.candidates);
  raw[0].facts[0].quote = '虚构配料';
  assert.deepEqual(materializeCandidates(sources, raw), [evidence]);
  raw[0].productLines = [0, 100];
  assert.equal(verifyCandidates(target, sources, materializeCandidates(sources, raw)).identityStatus, 'not_established');
  const outside = [{ ...finish.candidates[0], productLines: [1, 2] }];
  assert.equal(materializeCandidates(sources, outside)[0].facts[0].quote, '');
});

test('invalid targets fail before model or search work', async () => {
  const deps = harness([]);
  await assert.rejects(verifySku({ ...target, netQuantity: { value: -1, unit: 'L' } }, deps), /quantity/);
  assert.equal(deps.calls.length, 0);
  assert.throws(() => validateTarget({ ...target, officialDomains: ['https://example.com'] }));
});

test('Agent rejects undiscovered fetch targets', async () => {
  const deps = harness([{ action: 'fetch', sourceId: 'https://attacker.example' }]);
  const report = await verifySku(target, deps);
  assert.equal(report.failure.code, 'INVALID_ACTION');
  assert.equal(deps.calls.length, 0);
});

test('exhausted and failed runs never become completed verification', async () => {
  const report = await verifySku(target, { ...harness([finish, finish, finish]), maxSteps: 3 });
  assert.equal(report.status, 'budget_exhausted');
  assert.equal(report.verification.identityStatus, 'not_established');
  const deps = harness([{ action: 'search', query: '查询' }]);
  deps.client.search = async () => { throw new DeepSeekError('REQUEST_BUDGET_EXCEEDED', 'Budget exhausted.'); };
  const failure = await verifySku(target, deps);
  assert.equal(failure.status, 'failed');
  assert.equal(failure.failure.code, 'REQUEST_BUDGET_EXCEEDED');
});

test('Fetch 404 preserves search evidence and permits a finish', async () => {
  const deps = harness([{ action: 'search', query: '官方' }, { action: 'search', query: '零售' }, { action: 'fetch', sourceId: 's1' }, finish]);
  deps.client.fetch = async () => { throw new DeepSeekError('HTTP_ERROR', 'HTTP 404', { status: 404 }); };
  const report = await verifySku(target, deps);
  assert.equal(report.status, 'completed');
  assert.equal(report.sources[0].retrieval, 'search');
  assert.equal(report.trace[2].status, 404);
});

test('model client uses the documented endpoint, disabled thinking and JSON output', async () => {
  const client = new DeepSeekModel({ apiKey: 'secret-test-key', model: 'deepseek-flash', fetchImpl: async (url, request) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const body = JSON.parse(request.body);
    assert.equal(body.model, 'deepseek-flash');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.deepEqual(body.response_format, { type: 'json_object' });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(finish) } }], usage: { prompt_tokens: 40, completion_tokens: 10 } });
  } });
  assert.deepEqual(await client.next('json', {}), finish);
  assert.equal(client.usage.promptTokens, 40);
});

test('model client rejects truncated, blank or invalid JSON and redacts transport failures', async () => {
  for (const [reason, content] of [['length', '{}'], ['stop', ' '], ['stop', '{']]) {
    const model = new DeepSeekModel({ apiKey: 'secret-test-key', fetchImpl: async () => Response.json({ choices: [{ finish_reason: reason, message: { content } }] }) });
    await assert.rejects(model.next('json', {}), { code: 'MODEL_INVALID_OUTPUT' });
  }
  const model = new DeepSeekModel({ apiKey: 'secret-test-key', fetchImpl: async () => { throw new Error('secret-test-key'); } });
  await assert.rejects(model.next('json', {}), error => error.code === 'MODEL_NETWORK_ERROR' && !error.stack.includes('secret-test-key'));
});
