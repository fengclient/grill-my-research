import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createAlipay, PaidError } from './alipay.mjs';
import { PostgresPaidStore } from './paid-store.mjs';
import { createPaidVerifier } from './paid-verifier.mjs';
import { DeepSeekClient } from './deepseek.mjs';
import { DeepSeekModel } from './model.mjs';
import { verifySku } from './verify.mjs';

export function paidConfig(env = process.env) {
  if (!env.DATABASE_URL || typeof env.DEEPSEEK_API_KEY !== 'string' || !env.DEEPSEEK_API_KEY.trim() || /[\r\n]/.test(env.DEEPSEEK_API_KEY) || !env.ALIPAY_SERVICE_ID) throw Error('DATABASE_URL, DEEPSEEK_API_KEY and ALIPAY_SERVICE_ID are required.');
  const database = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname) throw Error('A network PostgreSQL DATABASE_URL is required.');
  if (env.ALIPAY_ENVIRONMENT === 'production' && !['verify-full','verify-ca'].includes(database.searchParams.get('sslmode'))) throw Error('Production PostgreSQL requires sslmode=verify-full or verify-ca.');
  const priceFen = Number(env.SKU_PRICE_FEN ?? 99);
  const executionTimeoutMs = Number(env.SKU_EXECUTION_TIMEOUT_MS ?? 780000);
  const port = Number(env._FAAS_RUNTIME_PORT || env.PORT || 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(priceFen) || priceFen < 1 || priceFen > 5000
    || !Number.isInteger(executionTimeoutMs) || executionTimeoutMs < 1 || executionTimeoutMs > 780000) throw Error('Invalid paid service limits.');
  return { databaseUrl: env.DATABASE_URL, priceFen, executionTimeoutMs, port, serviceId: env.ALIPAY_SERVICE_ID,
    goodsName: env.SKU_GOODS_NAME || 'SKU规格证据核验',
    alipay: { environment: env.ALIPAY_ENVIRONMENT, appId: env.ALIPAY_APP_ID,
      privateKey: env.ALIPAY_PRIVATE_KEY, alipayPublicKey: env.ALIPAY_PUBLIC_KEY } };
}
export function createPaidServer({ service, log = value => console.log(JSON.stringify(value)) }) {
  const server = createServer({ maxHeaderSize: 16384 }, async (request, response) => {
    const send = (status, value) => {
      if (response.destroyed) return;
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        ...(value.kind === 'payment_required' ? { amtPaymentLink: value.paymentLink } : {}) });
      response.end(JSON.stringify(value));
    };
    try {
      const url = new URL(request.url, 'http://service.local');
      if (url.search) throw new PaidError(400, 'INVALID_REQUEST');
      const recoverySecret = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
      if (!recoverySecret) throw new PaidError(401, 'UNAUTHORIZED');
      let result;
      const match = /^\/v1\/orders\/([a-f0-9]{32})$/.exec(url.pathname);
      if (request.method === 'GET' && match) {
        result = await service.recover({ orderId: match[1], recoverySecret });
      } else if (request.method === 'POST' && url.pathname === '/v1/verify') {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new PaidError(400, 'JSON_REQUIRED');
        let bytes = 0;
        const chunks = [];
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 32768) throw new PaidError(400, 'BODY_TOO_LARGE');
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { throw new PaidError(400, 'INVALID_JSON'); }
        if (!body || Array.isArray(body) || Object.keys(body).some(key => !['orderId','target'].includes(key))) throw new PaidError(400, 'INVALID_REQUEST');
        result = await service.request({ orderId: body.orderId, target: body.target, recoverySecret, paymentProofHeader: request.headers['payment-proof'] });
      } else throw new PaidError(404, 'NOT_FOUND');
      const status = { payment_required: 402, report: 200, running: 202, needs_review: 409 }[result.kind];
      send(status, result);
    } catch (error) {
      const status = error instanceof PaidError ? error.status : 503;
      if (status === 503) log({ event: 'paid_request_failed', error: 'SERVICE_UNAVAILABLE' });
      send(status, { error: error instanceof PaidError ? error.code : 'SERVICE_UNAVAILABLE' });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.timeout = 0;
  return server;
}
export async function startPaidServer(env = process.env) {
  const config = paidConfig(env);
  const alipay = createAlipay(config.alipay);
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5, connectionTimeoutMillis: 10000,
    statement_timeout: 10000, query_timeout: 15000 });
  pool.on('error', () => console.error(JSON.stringify({ event: 'paid_database_unavailable' })));
  try {
    const store = new PostgresPaidStore({ pool });
    await store.ready();
    const service = createPaidVerifier({ ...config, store, alipay,
      verify: (target, options) => verifySku(target, { ...options,
        client: new DeepSeekClient({ apiKey: env.DEEPSEEK_API_KEY, maxRequests: 12 }),
        model: new DeepSeekModel({ apiKey: env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL || 'deepseek-flash' }) }) });
    const server = createPaidServer({ service });
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(config.port, '0.0.0.0', resolveListen); });
    const stop = () => server.close(() => pool.end());
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    return server;
  } catch (error) { await pool.end(); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startPaidServer().catch(() => { console.error('Paid service startup failed. Check required merchant, database and provider configuration.'); process.exitCode = 1; });
}
