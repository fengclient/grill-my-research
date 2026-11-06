import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, stat, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const client = resolve('skills/sku-verifier/scripts/client.mjs');
const target = { brand: '测试品牌', productName: '茉莉花茶', netQuantity: { value: 500, unit: 'ml' }, officialDomains: [] };
const proof = Buffer.from(JSON.stringify({ protocol: { payment_proof: 'buyer-proof', trade_no: 'trade-one' }, method: { client_session: 'private-buyer-session' } })).toString('base64');

function invoke(args, input = '', extraEnv = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [client, ...args], { env: { ...process.env, SKU_VERIFIER_ENDPOINT: '', SKU_VERIFIER_ALLOW_LOCAL_HTTP: '1', ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolveResult({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function fixture(t, handler) {
  const directory = await mkdtemp(join(tmpdir(), 'sku-client-'));
  const run = join(directory, 'run');
  const input = join(directory, 'target.json');
  await writeFile(input, JSON.stringify(target));
  const requests = [];
  const errors = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.setHeader('Content-Type', 'application/json');
      await handler({ req, res, body, run, requests });
    } catch (error) { errors.push(error); res.writeHead(500).end('{}'); }
  });
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolveClosed => server.close(resolveClosed));
    assert.deepEqual(errors, []);
  });
  return { directory, run, input, origin, requests, quote: () => invoke(['quote', input, run, '--endpoint', origin]) };
}

function bill(res, orderId, overrides = {}) {
  const body = { kind: 'payment_required', orderId, amount: '0.99', currency: 'CNY', goodsName: 'SKU 证据调查', payBefore: '2030-01-01T00:00:00.000Z', paymentLink: 'amt-prepay-one', ...overrides };
  res.setHeader('amtPaymentLink', body.paymentLink);
  res.writeHead(402).end(JSON.stringify(body));
}

function clean(result, secret) {
  for (const value of [secret, proof, 'private-buyer-session']) assert.ok(!`${result.stdout}${result.stderr}`.includes(value));
}

test('receipt is durable and private before quote, execute saves exact report, recover is GET-only', async t => {
  let attempts = 0;
  let orderId;
  let secret;
  const report = { status: 'completed', verification: { matchedSourceCount: 0 }, limitations: ['No exact SKU evidence.'] };
  const markdown = '# Report\nNo exact SKU evidence.\n';
  const f = await fixture(t, async ({ req, res, body, run }) => {
    const receipt = JSON.parse(await readFile(join(run, 'receipt.json'), 'utf8'));
    assert.equal((await stat(run)).mode & 0o777, 0o700);
    assert.equal((await stat(join(run, 'receipt.json'))).mode & 0o777, 0o600);
    orderId ??= receipt.orderId;
    secret ??= receipt.recoverySecret;
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    assert.ok(!req.url.includes(secret));
    assert.equal(receipt.orderId, orderId);
    assert.deepEqual(receipt.target, target);
    if (req.method === 'GET') {
      assert.equal(req.url, `/v1/orders/${orderId}`);
      assert.equal(req.headers['payment-proof'], undefined);
      assert.equal(body, null);
    } else {
      assert.equal(req.url, '/v1/verify');
      assert.deepEqual(body, { orderId, target });
      if (!req.headers['payment-proof']) { bill(res, orderId); return; }
      assert.equal(req.headers['payment-proof'], proof);
      attempts += 1;
    }
    res.end(JSON.stringify({ kind: 'report', orderId, report, markdown }));
  });
  const quoted = await f.quote();
  assert.equal(quoted.code, 0, quoted.stderr);
  assert.equal(JSON.parse(quoted.stdout).amtPaymentLink, 'amt-prepay-one');
  assert.deepEqual(JSON.parse(await readFile(join(f.run, 'bill.json'))).amount, '0.99');
  const executed = await invoke(['execute', f.run, '--proof-stdin'], proof + '\n');
  assert.equal(executed.code, 0, executed.stderr);
  assert.equal(JSON.parse(executed.stdout).status, 'completed');
  assert.deepEqual(JSON.parse(await readFile(join(f.run, 'report.json'))), report);
  assert.equal(await readFile(join(f.run, 'report.md'), 'utf8'), markdown);
  const recovered = await invoke(['recover', f.run]);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(attempts, 1);
  assert.deepEqual(f.requests.map(request => request.method), ['POST', 'POST', 'GET']);
  for (const result of [quoted, executed, recovered]) clean(result, secret);
});

test('existing run directory never creates a replacement bill', async t => {
  const f = await fixture(t, ({ res, body }) => bill(res, body.orderId));
  assert.equal((await f.quote()).code, 0);
  const original = await readFile(join(f.run, 'receipt.json'), 'utf8');
  assert.equal((await f.quote()).code, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(await readFile(join(f.run, 'receipt.json'), 'utf8'), original);
});

test('recover keeps original unpaid bill and never posts', async t => {
  const f = await fixture(t, ({ req, res, body }) => bill(res, body?.orderId ?? req.url.split('/').at(-1)));
  await f.quote();
  assert.equal((await invoke(['recover', f.run])).code, 0);
  assert.deepEqual(f.requests.map(req => req.method), ['POST', 'GET']);
  assert.equal(new Set(f.requests.map(req => req.body?.orderId ?? req.url.split('/').at(-1))).size, 1);
});

for (const status of ['failed', 'budget_exhausted']) {
  test(`terminal ${status} is saved and honestly labelled without another execution`, async t => {
    const report = { status, failure: { code: 'PROVIDER_ERROR' } };
    const f = await fixture(t, ({ res, body }) => {
      res.end(JSON.stringify({ kind: 'report', orderId: body.orderId, report, markdown: `# ${status}\n` }));
    });
    const result = await f.quote();
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).status, status);
    assert.match(JSON.parse(result.stdout).next, /without completion/);
    assert.deepEqual(JSON.parse(await readFile(join(f.run, 'report.json'))), report);
    assert.equal(f.requests.length, 1);
  });
}

test('running and needs_review only suggest recovery or operator review', async t => {
  let orderId;
  const f = await fixture(t, ({ req, res, body }) => {
    orderId ??= body.orderId;
    if (req.method === 'POST') res.writeHead(202).end(JSON.stringify({ kind: 'running', orderId, retryAfterSeconds: 5 }));
    else res.writeHead(409).end(JSON.stringify({ kind: 'needs_review', orderId, reason: 'Interrupted execution' }));
  });
  const running = await f.quote();
  assert.equal(JSON.parse(running.stdout).kind, 'running');
  const review = await invoke(['recover', f.run]);
  assert.equal(review.code, 3);
  assert.equal(JSON.parse(review.stdout).kind, 'needs_review');
  assert.deepEqual(f.requests.map(req => req.method), ['POST', 'GET']);
});

test('invalid payment is an error without printing proof or purchasing again', async t => {
  const f = await fixture(t, ({ req, res, body }) => {
    if (!req.headers['payment-proof']) bill(res, body.orderId);
    else res.writeHead(402).end(JSON.stringify({ error: 'PAYMENT_INVALID' }));
  });
  await f.quote();
  const result = await invoke(['execute', f.run, '--proof-stdin'], proof);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /do not buy again/i);
  clean(result, JSON.parse(await readFile(join(f.run, 'receipt.json'))).recoverySecret);
  assert.equal(f.requests.length, 2);
});

for (const mutation of ['bad-order', 'bad-secret', 'bad-endpoint', 'public-file', 'symlink']) {
  test(`malformed or insecure receipt ${mutation} fails before networking`, async t => {
    const f = await fixture(t, ({ res, body }) => bill(res, body.orderId));
    await f.quote();
    const path = join(f.run, 'receipt.json');
    const receipt = JSON.parse(await readFile(path));
    if (mutation === 'bad-order') receipt.orderId = '../another-order';
    if (mutation === 'bad-secret') receipt.recoverySecret = 'a'.repeat(42) + '!';
    if (mutation === 'bad-endpoint') receipt.endpoint = 'http://remote.example';
    if (mutation === 'symlink') {
      const { unlink } = await import('node:fs/promises');
      const copy = join(f.directory, 'receipt-copy.json');
      await writeFile(copy, JSON.stringify(receipt), { mode: 0o600 });
      await unlink(path);
      await symlink(copy, path);
    } else await writeFile(path, JSON.stringify(receipt));
    if (mutation === 'public-file') await chmod(path, 0o644);
    const result = await invoke(['recover', f.run]);
    assert.equal(result.code, 1);
    assert.equal(f.requests.length, 1);
    clean(result, receipt.recoverySecret);
  });
}

test('redirects never forward recovery credentials or proof', async t => {
  let forwarded = 0;
  const other = createServer((req, res) => { forwarded += 1; res.end('{}'); });
  await new Promise(done => other.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => other.close(done)));
  const f = await fixture(t, ({ req, res, body }) => {
    if (!req.headers['payment-proof']) bill(res, body.orderId);
    else res.writeHead(307, { Location: `http://127.0.0.1:${other.address().port}/steal` }).end('{}');
  });
  await f.quote();
  const result = await invoke(['execute', f.run, '--proof-stdin'], proof);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /redirected/);
  assert.equal(forwarded, 0);
  assert.equal(f.requests.length, 2);
});

test('bounded proof and malformed proof are rejected before execution', async t => {
  const f = await fixture(t, ({ res, body }) => bill(res, body.orderId));
  await f.quote();
  for (const input of ['invalid-base64', 'A'.repeat(65540)]) {
    const result = await invoke(['execute', f.run, '--proof-stdin'], input);
    assert.equal(result.code, 1);
    assert.ok(!result.stderr.includes(input));
  }
  assert.equal(f.requests.length, 1);
});

test('response size is bounded and secret echoes are never printed or persisted', async t => {
  let mode = 'quote';
  const f = await fixture(t, ({ req, res, body }) => {
    if (mode === 'quote') { bill(res, body.orderId); return; }
    const orderId = req.url.split('/').at(-1);
    res.end(JSON.stringify({ kind: 'report', orderId, report: { status: 'completed' }, markdown: mode === 'large' ? 'x'.repeat(16 * 1024 * 1024) : req.headers.authorization }));
  });
  await f.quote();
  const secret = JSON.parse(await readFile(join(f.run, 'receipt.json'))).recoverySecret;
  for (mode of ['large', 'secret']) {
    const result = await invoke(['recover', f.run]);
    assert.equal(result.code, 1);
    clean(result, secret);
    await assert.rejects(readFile(join(f.run, 'report.json')), { code: 'ENOENT' });
  }
});

test('unexpected price and missing payment header cannot become payable bills', async t => {
  let header = true;
  const f = await fixture(t, ({ res, body }) => {
    if (header) bill(res, body.orderId, { amount: '9.90' });
    else res.writeHead(402).end(JSON.stringify({ kind: 'payment_required', orderId: body.orderId, amount: '0.99', currency: 'CNY', goodsName: 'SKU', payBefore: '2030-01-01T00:00:00Z', paymentLink: 'link' }));
  });
  let result = await f.quote();
  assert.equal(result.code, 1);
  await assert.rejects(readFile(join(f.run, 'bill.json')), { code: 'ENOENT' });
  header = false;
  result = await invoke(['quote', f.input, join(f.directory, 'other-run'), '--endpoint', f.origin]);
  assert.equal(result.code, 1);
});

test('production requires explicit safe HTTPS origin and never guesses an endpoint', async t => {
  const f = await fixture(t, ({ res, body }) => bill(res, body.orderId));
  for (const origin of [f.origin, 'http://remote.example', 'https://user:secret@example.com', 'https://example.com/api', 'https://example.com?secret=yes', 'https://example.com#fragment']) {
    const result = await invoke(['quote', f.input, f.run, '--endpoint', origin], '', { SKU_VERIFIER_ALLOW_LOCAL_HTTP: '' });
    assert.equal(result.code, 1);
  }
  assert.equal((await invoke(['quote', f.input, f.run])).code, 1);
  assert.equal(f.requests.length, 0);
  await assert.rejects(stat(f.run), { code: 'ENOENT' });
});

test('lost execution response recovers the committed report without another attempt', async t => {
  let attempts = 0;
  let report;
  const f = await fixture(t, ({ req, res, body }) => {
    if (req.method === 'POST' && !req.headers['payment-proof']) { bill(res, body.orderId); return; }
    if (req.method === 'POST') {
      attempts += 1;
      report = { kind: 'report', orderId: body.orderId, report: { status: 'completed', attempts }, markdown: '# Stored result\n' };
      res.destroy();
      return;
    }
    res.end(JSON.stringify(report));
  });
  await f.quote();
  const lost = await invoke(['execute', f.run, '--proof-stdin'], proof);
  assert.equal(lost.code, 1);
  assert.match(lost.stderr, /recover/i);
  const recovered = await invoke(['recover', f.run]);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(attempts, 1);
  assert.equal(JSON.parse(await readFile(join(f.run, 'report.json'))).attempts, 1);
  assert.deepEqual(f.requests.map(req => req.method), ['POST', 'POST', 'GET']);
});

test('escaped capabilities and decoded proof secrets cannot leak through bill or report', async t => {
  let mode = 'quote';
  const f = await fixture(t, ({ req, res, body }) => {
    if (mode === 'quote') { bill(res, body.orderId); return; }
    const orderId = body?.orderId ?? req.url.split('/').at(-1);
    const secret = req.headers.authorization.slice(7);
    const leak = mode === 'escaped' ? secret : 'private-buyer-session';
    const json = JSON.stringify({ kind: 'report', orderId, report: { status: 'completed' }, markdown: leak });
    res.end(mode === 'escaped' ? json.replace(secret[0], `\\u${secret.charCodeAt(0).toString(16).padStart(4, '0')}`) : json);
  });
  await f.quote();
  const secret = JSON.parse(await readFile(join(f.run, 'receipt.json'))).recoverySecret;
  mode = 'escaped';
  let result = await invoke(['recover', f.run]);
  assert.equal(result.code, 1);
  clean(result, secret);
  mode = 'session';
  result = await invoke(['execute', f.run, '--proof-stdin'], proof);
  assert.equal(result.code, 1);
  clean(result, secret);
  await assert.rejects(readFile(join(f.run, 'report.json')), { code: 'ENOENT' });
});


test('quote-again resumes the original bill after quote transport failure without payment or execution', async t => {
  let original;
  let attempts = 0;
  let quoteRequests = 0;
  const f = await fixture(t, ({ req, res, body }) => {
    assert.equal(req.headers['payment-proof'], undefined);
    if (req.method === 'GET') {
      assert.equal(req.headers.authorization, original.authorization);
      res.writeHead(503).end(JSON.stringify({ error: 'PAYMENT_PROVIDER_UNAVAILABLE' }));
      return;
    }
    quoteRequests += 1;
    if (!original) {
      original = { body, authorization: req.headers.authorization };
      res.destroy();
      return;
    }
    assert.deepEqual(body, original.body);
    assert.equal(req.headers.authorization, original.authorization);
    assert.equal(attempts, 0);
    bill(res, body.orderId);
  });
  const lost = await f.quote();
  assert.equal(lost.code, 1);
  assert.equal(quoteRequests, 1);
  const receiptBefore = await readFile(join(f.run, 'receipt.json'), 'utf8');
  const recovered = await invoke(['recover', f.run]);
  assert.equal(recovered.code, 1);
  assert.equal(quoteRequests, 1);
  const retry = await invoke(['quote-again', f.run]);
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).orderId, original.body.orderId);
  assert.equal(await readFile(join(f.run, 'receipt.json'), 'utf8'), receiptBefore);
  assert.equal(attempts, 0);
  assert.deepEqual(f.requests.map(req => req.method), ['POST', 'GET', 'POST']);
});

test('quote-again can return a committed report without proof or research', async t => {
  let reportReady = false;
  const report = { status: 'completed', stored: true };
  const f = await fixture(t, ({ req, res, body }) => {
    assert.equal(req.headers['payment-proof'], undefined);
    if (!reportReady) { bill(res, body.orderId); return; }
    res.end(JSON.stringify({ kind: 'report', orderId: body.orderId, report, markdown: '# Stored report\n' }));
  });
  await f.quote();
  reportReady = true;
  const result = await invoke(['quote-again', f.run]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(f.run, 'report.json'))), report);
  assert.deepEqual(f.requests.map(req => req.method), ['POST', 'POST']);
});

test('valid report plus markdown larger than 2 MiB is accepted within the envelope limit', async t => {
  const report = { status: 'completed', evidence: 'a'.repeat(1200 * 1024) };
  const markdown = '# Report\n' + 'b'.repeat(1200 * 1024);
  const f = await fixture(t, ({ res, body }) => {
    const json = JSON.stringify({ kind: 'report', orderId: body.orderId, report, markdown });
    assert.ok(Buffer.byteLength(json) > 2 * 1024 * 1024);
    res.end(json);
  });
  const result = await f.quote();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(f.run, 'report.json'))), report);
  assert.equal(await readFile(join(f.run, 'report.md'), 'utf8'), markdown);
});

test('target caps fail before the first network request', async t => {
  const f = await fixture(t, ({ res, body }) => bill(res, body.orderId));
  for (const preciseTarget of [
    { ...target, version: 'v'.repeat(121) },
    { ...target, packageForm: 'p'.repeat(121) },
    { ...target, netQuantity: { value: 500, unit: ' '.repeat(15) + 'ml' } },
    { ...target, officialDomains: Array.from({ length: 33 }, (_, index) => `brand${index}.example`) },
  ]) {
    await writeFile(f.input, JSON.stringify(preciseTarget));
    const result = await f.quote();
    assert.equal(result.code, 1);
  }
  assert.equal(f.requests.length, 0);
  await assert.rejects(stat(f.run), { code: 'ENOENT' });
});

test('expired quote keeps its receipt and bill without inviting payment, and finished report recovery still works', async t => {
  const expiredAt = '2000-01-01T00:00:00.000Z';
  const report = { status: 'completed', stored: true };
  const f = await fixture(t, ({ req, res, body }) => {
    if (req.method === 'POST') { bill(res, body.orderId, { payBefore: expiredAt }); return; }
    res.end(JSON.stringify({ kind: 'report', orderId: req.url.split('/').at(-1), report, markdown: '# Already-paid result\n' }));
  });
  const quoted = await f.quote();
  assert.equal(quoted.code, 1, quoted.stderr);
  const outcome = JSON.parse(quoted.stdout);
  assert.equal(outcome.kind, 'expired');
  assert.match(outcome.next, /do not pay/i);
  assert.doesNotMatch(outcome.next, /authorize this bill/i);
  const receipt = await readFile(join(f.run, 'receipt.json'), 'utf8');
  const savedBill = JSON.parse(await readFile(join(f.run, 'bill.json')));
  assert.equal(savedBill.expired, true);
  assert.equal(savedBill.payBefore, expiredAt);
  assert.equal(savedBill.orderId, JSON.parse(receipt).orderId);
  assert.equal(savedBill.amtPaymentLink, 'amt-prepay-one');
  const recovered = await invoke(['recover', f.run]);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).kind, 'report');
  assert.deepEqual(JSON.parse(await readFile(join(f.run, 'report.json'))), report);
  assert.equal(await readFile(join(f.run, 'receipt.json'), 'utf8'), receipt);
  assert.deepEqual(f.requests.map(req => req.method), ['POST', 'GET']);
});
