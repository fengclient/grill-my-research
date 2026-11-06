import { createHash, randomBytes } from 'node:crypto';
import { verifyCandidates } from '../src/evidence.mjs';
export const target = { brand: 'Test', productName: 'Tea', netQuantity: { value: 500, unit: 'ml' }, officialDomains: ['example.com'] };
export const newRequest = () => ({ orderId: randomBytes(16).toString('hex'), recoverySecret: randomBytes(32).toString('base64url'), target });
export const proofHeader = (tradeNo = 't'.repeat(32)) => Buffer.from(JSON.stringify({ protocol: { payment_proof: 'p'.repeat(64), trade_no: tradeNo }, method: { client_session: 'buyer-private-session' } })).toString('base64');
export const reportFor = (value, status = 'completed') => ({ schema: 'sku-verification-v1', status, target: value,
  startedAt: '2026-11-06T00:00:00.000Z', finishedAt: '2026-11-06T00:00:01.000Z',
  verification: verifyCandidates(value, [], []), sources: [], trace: [], failure: status === 'failed' ? { code: 'UPSTREAM' } : null, limitations: [], usage: {} });
export const payments = { precreate: async order => `amt_${order.order_id}`, verify: async (_order, proof) => proof.trade_no };

export function largeReport() {
  const report = reportFor(target);
  const quote = 'Test Tea 500ml\nIngredients water';
  const content = `${'unrelated\n'.repeat(250000)}${quote}`;
  report.sources = [{ id: 's1', title: 'Tea', url: 'https://example.com/tea', kind: 'official', content,
    contentSha256: createHash('sha256').update(content).digest('hex'), retrievedAt: report.finishedAt }];
  report.verification = verifyCandidates(target, report.sources, [{ sourceId: 's1', productQuote: quote, facts: [{ field: 'ingredients', quote: 'Ingredients water' }] }]);
  report.trace = [{ step: 1, action: 'finish', candidates: [{ sourceId: 's1', productLines: [250001, 250002], facts: [{ field: 'ingredients', lines: [250002, 250002] }] }] }];
  return report;
}
