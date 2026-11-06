import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
export class PostgresPaidStore {
  constructor({ pool }) { this.pool = pool; }

  async ready() { await this.pool.query('SELECT order_id, report, claim_token FROM paid_orders LIMIT 0'); }
  async get(orderId) {
    return (await this.pool.query('SELECT * FROM paid_orders WHERE order_id=$1', [orderId])).rows[0] ?? null;
  }
  async create(order) {
    await this.pool.query(`INSERT INTO paid_orders
      (order_id,capability_hash,target,target_hash,price_fen,service_id,goods_name,pay_before)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (order_id) DO NOTHING`,
    [order.orderId, order.capabilityHash, order.target, order.targetHash, order.priceFen,
      order.serviceId, order.goodsName, order.payBefore]);
    return this.get(order.orderId);
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
