import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalTarget, createPaidVerifier } from '../src/paid-verifier.mjs';
import { newRequest } from './paid-fixtures.mjs';

test('canonical target freezes a bounded identity without arbitrary client fields', () => {
  const { target } = newRequest();
  const canonical = canonicalTarget({ ...target, officialDomains: ['EXAMPLE.com','example.com'], ignored: 'instructions' });
  assert.deepEqual(canonical.officialDomains, ['example.com']); assert.equal(canonical.version, null); assert(!Object.hasOwn(canonical, 'ignored'));
  assert.deepEqual(canonicalTarget({ ...target, officialDomains: ['example.com'] }), canonical);
  for (const changed of [{ brand: '' }, { officialDomains: ['https://example.com'] }, { netQuantity: { value: -1, unit: 'ml' } }, { version: 'x'.repeat(121) }]) assert.throws(() => canonicalTarget({ ...target, ...changed }), error => error.code === 'INVALID_TARGET');
});

test('no implicit in-memory fallback or incomplete paid service', () => {
  assert.throws(() => createPaidVerifier());
  assert.throws(() => createPaidVerifier({ store: {}, alipay: {}, verify() {}, serviceId: 'service', priceFen: 5001 }));
});
