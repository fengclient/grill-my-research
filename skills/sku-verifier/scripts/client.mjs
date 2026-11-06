#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, lstat, rename, unlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';

const INPUT_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 16 * 1024 * 1024;
const USAGE = 'Usage: client.mjs quote <target.json> <new-run-dir> [--endpoint <https-origin>] | quote-again <run-dir> | execute <run-dir> --proof-stdin | recover <run-dir>';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { fail('Configure a valid HTTPS origin with --endpoint or SKU_VERIFIER_ENDPOINT.'); }
  const local = process.env.SKU_VERIFIER_ALLOW_LOCAL_HTTP === '1' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail('Endpoint must be an HTTPS origin without credentials, path, query, or fragment.');
  }
  return url.origin;
}

function target(value) {
  if (!object(value) || Object.keys(value).some(key => !['brand', 'productName', 'netQuantity', 'version', 'packageForm', 'officialDomains'].includes(key))) fail('Invalid target fields.');
  for (const key of ['brand', 'productName']) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 60) fail('Target brand and productName must contain 1 to 60 characters.');
  }
  const quantity = value.netQuantity;
  if (!object(quantity) || Object.keys(quantity).some(key => !['value', 'unit'].includes(key)) || !Number.isFinite(quantity.value) || quantity.value <= 0 || typeof quantity.unit !== 'string' || quantity.unit.length > 16
    || !['ml', '毫升', 'l', '升', 'g', '克', 'kg', '千克'].includes(quantity.unit.normalize('NFKC').toLowerCase().replace(/\s+/gu, ''))) fail('Invalid target netQuantity.');
  for (const key of ['version', 'packageForm']) {
    if (value[key] != null && (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 120)) fail('Invalid target version or packageForm.');
  }
  if (!Array.isArray(value.officialDomains) || value.officialDomains.length > 32 || value.officialDomains.some(domain => typeof domain !== 'string' || domain.length > 253 || !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(domain))) fail('Invalid target officialDomains.');
  return value;
}

async function readJson(path, privateFile = false) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > INPUT_LIMIT || (privateFile && (stat.mode & 0o077))) fail('Invalid or insecure local JSON file.');
    const data = Buffer.alloc(INPUT_LIMIT + 1);
    let length = 0;
    while (length <= INPUT_LIMIT) {
      const result = await handle.read(data, length, data.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > INPUT_LIMIT) fail('Local JSON exceeds 64 KiB.');
    return JSON.parse(data.subarray(0, length).toString('utf8'));
  } catch { fail('Cannot read valid bounded local JSON. Check the input file or private receipt.'); }
  finally { await handle?.close(); }
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function save(directory, name, data) {
  const temporary = join(directory, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, join(directory, name));
    await syncDirectory(directory);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => {});
  }
}

async function receipt(directory) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) fail('Run directory must be a private directory with mode 0700.');
  const value = await readJson(join(directory, 'receipt.json'), true);
  if (!object(value) || value.schemaVersion !== 1 || Object.keys(value).some(key => !['schemaVersion', 'orderId', 'recoverySecret', 'target', 'endpoint'].includes(key))
    || !/^[a-f0-9]{32}$/.test(value.orderId ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(value.recoverySecret ?? '')
    || Buffer.from(value.recoverySecret, 'base64url').toString('base64url') !== value.recoverySecret) fail('Invalid receipt. Do not create a replacement order to recover this run.');
  target(value.target);
  if (endpoint(value.endpoint) !== value.endpoint) fail('Invalid receipt endpoint.');
  return value;
}

async function proofFromStdin() {
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => process.stdin.destroy(new Error('Timed out reading proof.')), 30_000);
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > INPUT_LIMIT) fail('Payment proof exceeds 64 KiB.');
      chunks.push(chunk);
    }
  } finally { clearTimeout(timer); }
  const proof = Buffer.concat(chunks).toString('utf8').trim();
  if (!proof || proof.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(proof)
    || Buffer.from(proof, 'base64').toString('base64') !== proof) fail('Payment proof must be standard Base64 supplied through stdin.');
  return proof;
}

async function request(run, method, proof) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), proof ? 840_000 : 30_000);
  try {
    const response = await fetch(run.endpoint + (method === 'GET' ? `/v1/orders/${run.orderId}` : '/v1/verify'), {
      method, redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${run.recoverySecret}`, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...(proof ? { 'Payment-Proof': proof } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify({ orderId: run.orderId, target: run.target }) } : {}),
    });
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) fail('Service returned an invalid JSON response.');
    const reader = response.body?.getReader();
    if (!reader) fail('Service returned an empty response.');
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > RESPONSE_LIMIT) { await reader.cancel(); fail('Service response exceeds 16 MiB.'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw.includes(run.recoverySecret) || (proof && raw.includes(proof))) fail('Service response contains private credentials; refusing to save it.');
    let body;
    try { body = JSON.parse(raw); } catch { fail('Service returned malformed JSON.'); }
    if (!object(body)) fail('Service returned an invalid response.');
    const serialized = JSON.stringify(body);
    const privateValues = [run.recoverySecret, proof];
    if (proof) {
      try {
        const parsed = JSON.parse(Buffer.from(proof, 'base64').toString('utf8'));
        privateValues.push(parsed?.method?.client_session, parsed?.protocol?.payment_proof);
      } catch {}
    }
    if (privateValues.some(value => typeof value === 'string' && value.length > 0 && serialized.includes(value))) fail('Service response contains private credentials; refusing to save it.');
    return { status: response.status, body, paymentLink: response.headers.get('amtPaymentLink') };
  } finally { clearTimeout(timer); }
}

function text(value, maximum = 4096) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}

async function receive(directory, run, response) {
  const { status, body, paymentLink } = response;
  if (body.error) {
    const errors = { PAYMENT_INVALID: 'Payment proof was rejected. Recover this same order; do not buy again.', ORDER_EXPIRED: 'Order expired. Do not purchase a replacement automatically.', ORDER_TARGET_MISMATCH: 'Target differs from the original order. Keep the original receipt.' };
    fail(errors[body.error] ?? `Service rejected this request (HTTP ${status}). Recover the same order; no new purchase was made by this client.`);
  }
  if (body.orderId !== run.orderId) fail('Service returned a different order identity.');
  if (status === 402 && body.kind === 'payment_required') {
    if (body.amount !== '0.99' || body.currency !== 'CNY' || !text(body.goodsName, 1000) || !text(body.payBefore, 100) || !Number.isFinite(Date.parse(body.payBefore)) || !text(body.paymentLink) || paymentLink !== body.paymentLink) fail('Service returned an invalid or unexpected bill. Do not pay.');
    const expired = Date.parse(body.payBefore) <= Date.now();
    const bill = { kind: body.kind, orderId: run.orderId, amount: body.amount, currency: body.currency, goodsName: body.goodsName, payBefore: body.payBefore, amtPaymentLink: body.paymentLink, ...(expired ? { expired: true } : {}) };
    await save(directory, 'bill.json', JSON.stringify(bill, null, 2) + '\n');
    if (expired) return { ...bill, kind: 'expired', next: 'This original bill has expired. Do not pay or purchase a replacement automatically. Keep the receipt; use recover to check an already-paid result or contact the operator.' };
    return { ...bill, next: 'Authorize this bill, then hand amtPaymentLink to an available official current MachinePay buyer capability. Do not invent a wallet command. Return its proof via execute --proof-stdin.' };
  }
  if (status === 200 && body.kind === 'report') {
    if (!object(body.report) || !['completed', 'failed', 'budget_exhausted'].includes(body.report.status) || typeof body.markdown !== 'string') fail('Service returned an invalid report.');
    await save(directory, 'report.json', JSON.stringify(body.report, null, 2) + '\n');
    await save(directory, 'report.md', body.markdown);
    return { kind: 'report', orderId: run.orderId, status: body.report.status, reportJson: 'report.json', reportMarkdown: 'report.md', next: body.report.status === 'completed' ? 'Read the report and its evidence gaps.' : 'This investigation ended without completion. Read its failure or budget limitations. Do not purchase or rerun automatically.' };
  }
  if (status === 202 && body.kind === 'running' && body.retryAfterSeconds === 5) return { kind: 'running', orderId: run.orderId, retryAfterSeconds: 5, next: 'Use recover for this same run later. No retry was sent automatically.' };
  if (status === 409 && body.kind === 'needs_review' && text(body.reason, 1000)) return { kind: 'needs_review', orderId: run.orderId, next: 'The service needs operator review. Keep the receipt and orderId. Do not buy again or rerun.' };
  fail(`Unexpected service response (HTTP ${status}). Recover this same order; do not buy again.`);
}

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(USAGE); return; }
  const [command, input, output, flag, value] = args;
  let directory;
  let run;
  let proof;
  if (command === 'quote' && input && output && (args.length === 3 || (args.length === 5 && flag === '--endpoint'))) {
    const origin = endpoint(value ?? process.env.SKU_VERIFIER_ENDPOINT);
    const preciseTarget = target(await readJson(resolve(input)));
    directory = resolve(output);
    await mkdir(directory, { mode: 0o700 });
    await syncDirectory(dirname(directory));
    run = { schemaVersion: 1, orderId: randomBytes(16).toString('hex'), recoverySecret: randomBytes(32).toString('base64url'), endpoint: origin, target: preciseTarget };
    await save(directory, 'receipt.json', JSON.stringify(run, null, 2) + '\n');
  } else if ((['recover', 'quote-again'].includes(command) && args.length === 2) || (command === 'execute' && args.length === 3 && output === '--proof-stdin')) {
    directory = resolve(input);
    run = await receipt(directory);
    if (command === 'execute') proof = await proofFromStdin();
  } else fail(USAGE);
  try {
    const result = await receive(directory, run, await request(run, command === 'recover' ? 'GET' : 'POST', proof));
    console.log(JSON.stringify(result));
    if (result.kind === 'needs_review') process.exitCode = 3;
    if (result.kind === 'expired') process.exitCode = 1;
  } catch (error) {
    if (error instanceof TypeError || error.name === 'AbortError') {
      const next = ['quote', 'quote-again'].includes(command) ? 'Keep this run. Use recover, or explicitly quote-again to retry only this original bill.' : 'Keep this run and use recover.';
      fail(`Network request failed, timed out, or redirected. ${next} Do not create another purchase.`);
    }
    throw error;
  }
}

main(process.argv.slice(2)).catch(error => {
  const safe = error.code ? 'Local file operation failed. Keep the original private run directory.' : error.message;
  console.error(safe || 'Client failed. Keep the original receipt and recover the same order.');
  process.exitCode = 1;
});
