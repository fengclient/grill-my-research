import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { DeepSeekClient } from './deepseek.mjs';
import { DeepSeekModel } from './model.mjs';
import { validateTarget } from './evidence.mjs';
import { verifySku } from './verify.mjs';
import { renderReport } from './report.mjs';

export const JOB_TIMEOUT_MS = 780_000;
export const MAX_BODY_BYTES = 32_768;
const hash = value => createHash('sha256').update(value).digest('hex');

export function createCloudServer({ token,
  verify = (target, options) => verifySku(target, { ...options,
    client: new DeepSeekClient({ maxRequests: 12 }), model: new DeepSeekModel() }),
  log = value => console.log(JSON.stringify(value)), timeoutMs = JOB_TIMEOUT_MS,
} = {}) {
  if (typeof token !== 'string' || token.length < 32) {
    throw new Error('Set SKU_WORKER_TOKEN to a random secret of at least 32 characters.');
  }
  const tokenHash = Buffer.from(hash(`Bearer ${token}`));
  const active = new Set();
  const server = createServer(async (request, response) => {
    const send = (status, value, markdown = false) => {
      if (response.destroyed) return;
      response.writeHead(status, { 'content-type': markdown ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8',
        'cache-control': 'no-store' });
      response.end(markdown ? value : JSON.stringify(value));
    };
    try {
      const supplied = request.headers.authorization ?? '';
      if (!timingSafeEqual(tokenHash, Buffer.from(hash(supplied)))) return send(401, { error: 'UNAUTHORIZED' });
      const url = new URL(request.url, 'http://worker.local');
      if (request.method === 'GET' && url.pathname === '/health') return send(200, { status: 'ok' });
      if (request.method !== 'POST' || url.pathname !== '/verify') return send(404, { error: 'NOT_FOUND' });
      if (active.size) return send(429, { error: 'INSTANCE_BUSY' });
      if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'JSON_REQUIRED' });
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) return send(413, { error: 'BODY_TOO_LARGE' });
        chunks.push(chunk);
      }
      let target;
      try { target = validateTarget(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { return send(400, { error: 'INVALID_TARGET' }); }
      // Reserve after awaiting the body too: two slow uploads can arrive together.
      if (active.size) return send(429, { error: 'INSTANCE_BUSY' });
      const controller = new AbortController();
      active.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const disconnected = () => { if (!response.writableFinished) controller.abort(); };
      response.on('close', disconnected);
      try {
        const report = await verify(target, { signal: controller.signal });
        log({ event: 'verification_finished', requestId: request.headers['x-faas-request-id'] ?? null,
          status: report.status, reportSha256: hash(JSON.stringify(report)),
          matchedSourceCount: report.verification.matchedSourceCount, usage: report.usage });
        send(report.status === 'completed' ? 200 : 502,
          url.searchParams.get('format') === 'markdown' ? renderReport(report) : report,
          url.searchParams.get('format') === 'markdown');
      } finally {
        clearTimeout(timer);
        active.delete(controller);
        response.off('close', disconnected);
      }
    } catch {
      log({ event: 'request_failed', error: 'VERIFICATION_ERROR' });
      send(500, { error: 'VERIFICATION_ERROR' });
    }
  });
  server.stop = () => {
    for (const controller of active) controller.abort();
    server.close();
  };
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('Missing DEEPSEEK_API_KEY.');
  const server = createCloudServer({ token: process.env.SKU_WORKER_TOKEN });
  server.listen(Number(process.env._FAAS_RUNTIME_PORT || process.env.PORT || 8000), '0.0.0.0');
  process.on('SIGTERM', () => server.stop());
  process.on('SIGINT', () => server.stop());
}
