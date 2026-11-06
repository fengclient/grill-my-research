import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cloud-cli.mjs';
import { verifyCandidates } from '../src/evidence.mjs';

const target = { brand: '示例茶', productName: '茉莉茶', netQuantity: { value: 500, unit: 'mL' },
  officialDomains: ['example.com'], version: null, packageForm: null };
const report = { schema: 'sku-verification-v1', status: 'completed', target, finishedAt: '2026-11-06T00:00:00Z',
  sources: [], verification: verifyCandidates(target, [], []), limitations: [], usage: {} };
const token = 'fake-token-with-at-least-32-characters';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'sku-cloud-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'target.json');
  const config = join(root, 'deployment.json');
  const output = join(root, 'report');
  await writeFile(input, JSON.stringify(target));
  await writeFile(config, JSON.stringify({ accountId: '123456', region: 'cn-beijing', functionId: 'example' }));
  return [input, output, config];
}

test('cloud CLI checks account, invokes once and saves JSON/Markdown without persisting its token', async t => {
  const args = await setup(t);
  let count = 0;
  const call = async argv => {
    count += 1;
    if (argv[0] === 'whoami') return { ok: true, data: { account_id: '123456' } };
    const request = JSON.parse(argv[argv.indexOf('--requestJson') + 1]);
    assert.equal(request.path, '/verify');
    assert.deepEqual(request.data, target);
    return { ok: true, data: { statusCode: 200, response: JSON.stringify(report), instanceName: 'test-instance', stats: [] } };
  };
  assert.equal(await main(args, { token, call, stdout: () => {} }), 0);
  assert.deepEqual(JSON.parse(await readFile(join(args[1], 'report.json'), 'utf8')), report);
  assert.match(await readFile(join(args[1], 'report.md'), 'utf8'), /SKU 核验/);
  assert.ok(!(await readFile(join(args[1], 'invocation.json'), 'utf8')).includes(token));
  assert.equal(count, 2);
  assert.equal(await main(args, { token, call, stderr: () => {} }), 1);
  assert.equal(count, 2, 'existing output must prevent another cloud invocation');
});

test('cloud CLI refuses the wrong account before paid verification', async t => {
  const args = await setup(t);
  const output = [];
  const call = async argv => {
    assert.equal(argv[0], 'whoami');
    return { ok: true, data: { account_id: 'other' } };
  };
  assert.equal(await main(args, { token, call, stderr: value => output.push(value) }), 1);
  assert.deepEqual(JSON.parse(output[0]), { error: 'CLOUD_ACCOUNT_MISMATCH', uncertainOutcome: false, automaticRetry: false });
});

test('cloud CLI retains failed reports and never automatically retries an uncertain transport failure', async t => {
  const args = await setup(t);
  const failed = { ...report, status: 'failed' };
  const call = async argv => argv[0] === 'whoami' ? { ok: true, data: { account_id: '123456' } }
    : { ok: true, data: { statusCode: 502, response: JSON.stringify(failed) } };
  assert.equal(await main(args, { token, call, stdout: () => {} }), 1);
  assert.equal(JSON.parse(await readFile(join(args[1], 'report.json'), 'utf8')).status, 'failed');
  let attempts = 0;
  const errors = [];
  const uncertain = async argv => {
    if (argv[0] === 'whoami') return { ok: true, data: { account_id: '123456' } };
    attempts += 1; throw new Error('SECRET_TRANSPORT_DETAILS');
  };
  assert.equal(await main([args[0], args[1] + '-uncertain', args[2]], { token, call: uncertain, stderr: v => errors.push(v) }), 1);
  assert.equal(attempts, 1);
  assert.equal(JSON.parse(errors[0]).uncertainOutcome, true);
  assert.ok(!errors[0].includes('SECRET'));
});
