import { createHash } from 'node:crypto';
import { PaidError } from './alipay.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export class PostgresPaidStore {
  constructor({ pool, quoteLimits = { perMinute: 20, perDay: 200 } }) {
    if (!Number.isInteger(quoteLimits.perMinute) || quoteLimits.perMinute < 1 || quoteLimits.perMinute > 1000
      || !Number.isInteger(quoteLimits.perDay) || quoteLimits.perDay < 1 || quoteLimits.perDay > 100000) throw Error('Invalid quote rate limits.');
    this.pool = pool;
    this.quoteLimits = { ...quoteLimits };
  }

  async ready() { await this.pool.query('SELECT order_id, report, claim_token FROM paid_orders LIMIT 0'); }
  async get(orderId) {
    return (await this.pool.query('SELECT * FROM paid_orders WHERE order_id=$1', [orderId])).rows[0] ?? null;
  }
  async create(order) {
    const client = await this.pool.connect();
    let rollbackFailure;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query('SELECT pg_advisory_xact_lock(738120,1)');
      const existing = (await client.query('SELECT * FROM paid_orders WHERE order_id=$1', [order.orderId])).rows[0];
      if (existing) { await client.query('COMMIT'); return existing; }
      const counts = (await client.query(`SELECT count(*) FILTER (WHERE created_at >= statement_timestamp() - interval '1 minute') AS minute_count,
        count(*) AS day_count FROM paid_orders WHERE created_at >= statement_timestamp() - interval '24 hours'`)).rows[0];
      if (Number(counts.minute_count) >= this.quoteLimits.perMinute || Number(counts.day_count) >= this.quoteLimits.perDay) throw new PaidError(429, 'QUOTE_RATE_LIMITED');
      const inserted = (await client.query(`INSERT INTO paid_orders
        (order_id,capability_hash,target,target_hash,price_fen,service_id,goods_name,pay_before,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,statement_timestamp()) ON CONFLICT (order_id) DO NOTHING RETURNING *`,
      [order.orderId, order.capabilityHash, order.target, order.targetHash, order.priceFen,
        order.serviceId, order.goodsName, order.payBefore])).rows[0];
      const result = inserted ?? (await client.query('SELECT * FROM paid_orders WHERE order_id=$1', [order.orderId])).rows[0];
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (rollbackError) { rollbackFailure = rollbackError; }
      throw error;
    } finally {
      if (rollbackFailure) client.release(rollbackFailure);
      else client.release();
    }
  }
  async setPaymentLink(orderId, paymentLink) {
    await this.pool.query(`UPDATE paid_orders SET payment_link=$2 WHERE order_id=$1 AND payment_link IS NULL AND state='awaiting_payment'`, [orderId, paymentLink]);
    return this.get(orderId);
  }
  async claim({ orderId, capabilityHash, targetHash, tradeNo, claimToken, started, deadline }) {
    try {
      const result = await this.pool.query(`UPDATE paid_orders SET state='running',trade_no=$4,
        claim_token=$5,execution_started=$6,execution_deadline=$7
        WHERE order_id=$1 AND capability_hash=$2 AND target_hash=$3 AND state='awaiting_payment' RETURNING *`,
      [orderId, capabilityHash, targetHash, tradeNo, claimToken, started, deadline]);
      return result.rows[0] ?? null;
    } catch (error) {
      if (error.code === '23505') return null;
      throw error;
    }
  }
  async finish(orderId, claimToken, report, markdown) {
    const serialized = JSON.stringify(report);
    if (Buffer.byteLength(serialized) > 2_097_152 || Buffer.byteLength(markdown) > 2_097_152) throw new Error('REPORT_TOO_LARGE');
    const result = await this.pool.query(`UPDATE paid_orders SET state='finished',report=$3,markdown=$4,report_sha256=$5,reason=NULL
      WHERE order_id=$1 AND claim_token=$2 AND state IN ('running','needs_review') RETURNING *`,
    [orderId, claimToken, serialized, markdown, hash(serialized)]);
    if (result.rows[0]) return result.rows[0];
    const stored = await this.get(orderId);
    if (stored?.state === 'finished' && stored.claim_token === claimToken && stored.report_sha256 === hash(serialized)) return stored;
    throw new Error('CLAIM_LOST');
  }
  async needsReview(orderId, claimToken, reason) {
    await this.pool.query(`UPDATE paid_orders SET state='needs_review',reason=$3
      WHERE order_id=$1 AND claim_token=$2 AND state='running'`, [orderId, claimToken, reason]);
  }
}
