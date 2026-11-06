import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { validateTarget } from './evidence.mjs';
import { preparePaidReport } from './paid-report.mjs';
import { PaidError, amountYuan, parsePaymentProof } from './alipay.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export function canonicalTarget(input) {
  try {
    validateTarget(input);
    if (input.officialDomains.length > 32 || ['version','packageForm'].some(key => input[key]?.length > 120)
      || typeof input.netQuantity.unit !== 'string' || input.netQuantity.unit.length > 16) throw Error();
    return { brand: input.brand.trim(), productName: input.productName.trim(),
      netQuantity: { value: input.netQuantity.value, unit: input.netQuantity.unit },
      version: input.version ?? null, packageForm: input.packageForm ?? null,
      officialDomains: [...new Set(input.officialDomains.map(value => value.toLowerCase()))].sort() };
  } catch { throw new PaidError(400, 'INVALID_TARGET'); }
}
function identity(orderId, recoverySecret) {
  if (!/^[a-f0-9]{32}$/.test(orderId ?? '')) throw new PaidError(400, 'INVALID_ORDER_ID');
  if (typeof recoverySecret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(recoverySecret)
    || Buffer.from(recoverySecret, 'base64url').toString('base64url') !== recoverySecret) throw new PaidError(401, 'UNAUTHORIZED');
  return hash(recoverySecret);
}
function authorize(order, capabilityHash, targetHash) {
  if (!order || !timingSafeEqual(Buffer.from(order.capability_hash), Buffer.from(capabilityHash))) throw new PaidError(401, 'UNAUTHORIZED');
  if (targetHash && order.target_hash !== targetHash) throw new PaidError(409, 'ORDER_TARGET_MISMATCH');
}
export function createPaidVerifier({ store, alipay, verify, serviceId, goodsName = 'SKU规格证据核验', priceFen = 99,
  now = Date.now, executionTimeoutMs = 780000, graceMs = 30000, quoteTtlMs = 1800000 } = {}) {
  if (!store || !alipay || typeof verify !== 'function' || typeof serviceId !== 'string' || !serviceId.trim() || serviceId.length > 32
    || typeof goodsName !== 'string' || !goodsName.trim() || goodsName.length > 32 || !Number.isInteger(priceFen) || priceFen < 1 || priceFen > 5000
    || !Number.isInteger(executionTimeoutMs) || executionTimeoutMs < 1 || executionTimeoutMs > 780000
    || quoteTtlMs < 1000 || quoteTtlMs > 43200000) throw Error('Invalid paid verifier configuration.');
  let active = false;
  async function outcome(order) {
    if (order.state === 'finished') return { kind: 'report', orderId: order.order_id, report: order.report, markdown: order.markdown };
    if (order.state === 'running' && now() > new Date(order.execution_deadline).getTime() + graceMs) {
      return { kind: 'needs_review', orderId: order.order_id, reason: 'EXECUTION_DEADLINE_EXCEEDED' };
    }
    if (order.state === 'needs_review') return { kind: 'needs_review', orderId: order.order_id, reason: order.reason };
    if (order.state === 'running') return { kind: 'running', orderId: order.order_id, retryAfterSeconds: 5 };
    if (now() > new Date(order.pay_before).getTime()) throw new PaidError(409, 'ORDER_EXPIRED');
    if (!order.payment_link) throw new PaidError(503, 'PAYMENT_NOT_READY');
    return { kind: 'payment_required', orderId: order.order_id, amount: amountYuan(order.price_fen), currency: 'CNY',
      goodsName: order.goods_name, payBefore: new Date(order.pay_before).toISOString(), paymentLink: order.payment_link };
  }
  return {
    async recover({ orderId, recoverySecret }) {
      const capabilityHash = identity(orderId, recoverySecret);
      const order = await store.get(orderId);
      if (!order) throw new PaidError(404, 'ORDER_NOT_FOUND');
      authorize(order, capabilityHash);
      return outcome(order);
    },
    async request({ orderId, recoverySecret, target: input, paymentProofHeader }) {
      const capabilityHash = identity(orderId, recoverySecret);
      const target = canonicalTarget(input);
      const targetHash = hash(JSON.stringify(target));
      const proof = paymentProofHeader === undefined ? null : parsePaymentProof(paymentProofHeader);
      let order = await store.get(orderId);
      if (!order) {
        if (proof) throw new PaidError(404, 'ORDER_NOT_FOUND');
        order = await store.create({ orderId, capabilityHash, target, targetHash, priceFen, serviceId, goodsName,
          payBefore: new Date(now() + quoteTtlMs).toISOString() });
      }
      authorize(order, capabilityHash, targetHash);
      if (order.state !== 'awaiting_payment') return outcome(order);
      if (!proof) {
        if (now() > new Date(order.pay_before).getTime()) throw new PaidError(409, 'ORDER_EXPIRED');
        if (!order.payment_link) order = await store.setPaymentLink(orderId, await alipay.precreate(order));
        return outcome(order);
      }
      if (active) throw new PaidError(429, 'INSTANCE_BUSY');
      let tradeNo;
      try { tradeNo = await alipay.verify(order, proof); }
      catch (error) {
        const current = await store.get(orderId);
        if (current.state !== 'awaiting_payment') return outcome(current);
        throw error;
      }
      if (active) throw new PaidError(429, 'INSTANCE_BUSY');
      const claimToken = randomBytes(32).toString('hex');
      active = true;
      try {
        order = await store.claim({ orderId, capabilityHash, targetHash, tradeNo, claimToken,
          started: new Date(now()).toISOString(), deadline: new Date(now() + executionTimeoutMs).toISOString() });
      } catch (error) { active = false; throw error; }
      if (!order) {
        active = false;
        const existing = await store.get(orderId);
        if (existing.state !== 'awaiting_payment') return outcome(existing);
        throw new PaidError(402, 'PAYMENT_INVALID');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), executionTimeoutMs);
      try {
        const completed = await verify(order.target, { signal: controller.signal });
        const { report, markdown } = preparePaidReport(completed, order.target);
        try { order = await store.finish(orderId, claimToken, report, markdown); }
        catch { order = await store.finish(orderId, claimToken, report, markdown); }
        return outcome(order);
      } catch {
        try { await store.needsReview(orderId, claimToken, 'EXECUTION_OR_PERSISTENCE_UNCERTAIN'); } catch {}
        throw new PaidError(503, 'ORDER_OUTCOME_UNCERTAIN');
      } finally { clearTimeout(timer); active = false; }
    },
  };
}
