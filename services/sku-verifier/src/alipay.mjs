import { createPrivateKey, createPublicKey } from 'node:crypto';
import { AlipaySdk } from 'alipay-sdk';

export class PaidError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export const amountYuan = fen => `${Math.floor(fen / 100)}.${String(fen % 100).padStart(2, '0')}`;
export function parsePaymentProof(header) {
  try {
    if (typeof header !== 'string' || header.length > 8192 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(header)) throw Error();
    const raw = Buffer.from(header, 'base64');
    if (raw.toString('base64') !== header) throw Error();
    const proof = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    const { payment_proof: paymentProof, trade_no: tradeNo } = proof.protocol ?? {};
    const clientSession = proof.method?.client_session;
    if (typeof paymentProof !== 'string' || paymentProof.length !== 64 || /[\x00-\x20]/.test(paymentProof)
      || typeof tradeNo !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(tradeNo)
      || typeof clientSession !== 'string' || !clientSession.trim() || clientSession.length > 1024) throw Error();
    return { payment_proof: paymentProof, trade_no: tradeNo, client_session: clientSession };
  } catch { throw new PaidError(400, 'INVALID_PAYMENT_PROOF'); }
}
const gateways = Object.freeze({ production: 'https://openapi.alipay.com/gateway.do', sandbox: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do' });
export function createAlipay({ environment, appId, privateKey, alipayPublicKey }) {
  if (!Object.hasOwn(gateways, environment) || !/^[0-9]{1,32}$/.test(appId ?? '') || !privateKey || !alipayPublicKey) throw Error('Missing or invalid Alipay configuration.');
  const signingKey = createPrivateKey(privateKey);
  const verificationKey = createPublicKey(alipayPublicKey);
  if (signingKey.asymmetricKeyType !== 'rsa' || verificationKey.asymmetricKeyType !== 'rsa') throw Error('Alipay RSA keys required.');
  const sdk = new AlipaySdk({ appId, privateKey: signingKey.export({ type: 'pkcs8', format: 'pem' }),
    alipayPublicKey: verificationKey.export({ type: 'spki', format: 'pem' }), keyType: 'PKCS8',
    gateway: gateways[environment], camelcase: false, signType: 'RSA2', timeout: 15000 });
  return new AlipayPayments(sdk);
}
export class AlipayPayments {
  constructor(sdk) {
    if (!sdk?.config?.alipayPublicKey || sdk.config.camelcase !== false) throw Error('Verified snake_case Alipay SDK configuration required.');
    this.sdk = sdk;
  }
  async call(method, bizContent) {
    try { return await this.sdk.exec(method, { bizContent }, { validateSign: true }); }
    catch { throw new PaidError(503, 'PAYMENT_PROVIDER_UNAVAILABLE'); }
  }
  async precreate(order) {
    const result = await this.call('alipay.aipay.agent.payment.precreate', {
      out_trade_no: order.order_id, amount: amountYuan(order.price_fen), currency: order.currency,
      goods_name: order.goods_name, service_id: order.service_id, pay_before: new Date(order.pay_before).toISOString(),
    });
    if (result?.code !== '10000' || typeof result.amt_pre_pay_id !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(result.amt_pre_pay_id)) throw new PaidError(503, 'PAYMENT_PROVIDER_UNAVAILABLE');
    return result.amt_pre_pay_id;
  }
  async verify(order, proof) {
    const result = await this.call('alipay.aipay.agent.payment.verify', proof);
    if (result?.code === '20000') throw new PaidError(503, 'PAYMENT_PROVIDER_UNAVAILABLE');
    const value = typeof result?.amount === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(result.amount) ? result.amount.split('.') : null;
    const fen = value ? Number(value[0]) * 100 + Number((value[1] ?? '').padEnd(2, '0')) : NaN;
    if (result?.code !== '10000' || result.active !== true || fen !== order.price_fen
      || result.out_trade_no !== order.order_id || result.trade_no !== proof.trade_no) throw new PaidError(402, 'PAYMENT_INVALID');
    return result.trade_no;
  }
}
