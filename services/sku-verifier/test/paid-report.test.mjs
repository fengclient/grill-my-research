import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { preparePaidReport, PAID_REPORT_BYTES } from '../src/paid-report.mjs';
import { reportFor, target, largeReport } from './paid-fixtures.mjs';

test('ordinary paid report remains unchanged', () => {
  const original = reportFor(target);
  assert.equal(preparePaidReport(original).report, original);
});

test('oversized raw sources produce an explicitly bounded report without changing quotes or cited lines', () => {
  const original = largeReport();
  const { report, markdown } = preparePaidReport(original);
  assert.equal(report.status, 'completed');
  assert.equal(report.delivery.truncated, true);
  assert.equal(report.delivery.omitted.sourceContents, 1);
  assert.equal(report.sources[0].content, undefined);
  assert.equal(report.sources[0].contentOmitted.bytes, Buffer.byteLength(original.sources[0].content));
  assert.equal(report.sources[0].contentOmitted.sha256, original.sources[0].contentSha256);
  assert.deepEqual(report.verification, original.verification);
  assert.equal(report.verification.matchedSourceCount, 1);
  assert.equal(report.verification.matchedDomainCount, 1);
  assert.equal(report.verification.officialMatchedSourceCount, 1);
  assert.deepEqual(report.trace, original.trace);
  assert.match(markdown, /报告交付体积受限/);
  assert(Buffer.byteLength(JSON.stringify(report)) <= PAID_REPORT_BYTES);
  assert(Buffer.byteLength(markdown) <= PAID_REPORT_BYTES);
  assert(original.sources[0].content.length > 2500000);
});

test('large citation fanout omits whole entries with exact counts while retaining every delivered quote intact', () => {
  const original = reportFor(target);
  original.verification.fields[0].status = 'review_variants';
  original.verification.fields[0].statements = Array.from({ length: 900 }, (_, index) => ({ sourceId: 's1', quote: `${index}`.padEnd(600, '\u0001') }));
  original.verification.matches = Array.from({ length: 30 }, (_, index) => ({ sourceId: 's1', productQuote: `${index}`.padEnd(2400, '\u0001') }));
  const { report, markdown } = preparePaidReport(original);
  assert.equal(report.status, 'completed');
  assert(report.delivery.omitted.statements > 0);
  assert.equal(report.verification.fields[0].statements.length + report.delivery.omitted.statements, 900);
  assert.deepEqual(report.verification.matches, original.verification.matches);
  assert.equal(report.verification.fields[0].status, 'review_variants');
  assert.equal(report.verification.fields[0].delivery.omittedStatements, report.delivery.omitted.statements);
  assert.equal(report.verification.fields[0].delivery.originalStatementCount, 900);
  assert(report.verification.fields[0].statements.length >= 2);
  const quotes = new Set(original.verification.fields[0].statements.map(row => row.quote));
  for (const statement of report.verification.fields[0].statements) assert(quotes.has(statement.quote));
  assert(Buffer.byteLength(JSON.stringify(report)) <= PAID_REPORT_BYTES);
  assert(Buffer.byteLength(markdown) <= PAID_REPORT_BYTES);
});

test('a conflict witness near the end survives omission of excess evidence', () => {
  const original = reportFor(target);
  const field = original.verification.fields[0];
  field.status = 'review_variants';
  field.statements = Array.from({ length: 900 }, (_, index) => ({ sourceId: 's1', quote: '\u0001'.repeat(600) }));
  field.statements.push({ sourceId: 's2', quote: 'different source formulation' });
  const { report } = preparePaidReport(original);
  const delivered = report.verification.fields[0];
  assert.equal(delivered.status, 'review_variants');
  assert(delivered.statements.some(statement => statement.quote === '\u0001'.repeat(600)));
  assert(delivered.statements.some(statement => statement.quote === 'different source formulation'));
});

test('unsupported Unicode anywhere becomes an explicit safe failed report with original report hash', () => {
  for (const invalid of ['\u0000', '\ud800', '\udc00']) {
    for (const location of ['source', 'quote', 'nested', 'key']) {
      const original = reportFor(target);
      if (location === 'source') original.sources = [{ content: `water${invalid}tea` }];
      if (location === 'quote') original.verification.fields[0].statements = [{ sourceId: 's1', quote: `water${invalid}tea` }];
      if (location === 'nested') original.usage = { provider: { detail: [invalid] } };
      if (location === 'key') original.usage = { [invalid]: 'value' };
      const { report, markdown } = preparePaidReport(original, target);
      assert.equal(report.status, 'failed');
      assert.equal(report.failure.code, 'REPORT_UNSUPPORTED_UNICODE');
      assert.equal(report.delivery.reason, 'UNSUPPORTED_UNICODE');
      assert.equal(report.delivery.originalReport.sha256, createHash('sha256').update(JSON.stringify(original)).digest('hex'));
      assert.equal(report.sources.length, 0); assert.equal(report.verification.matches.length, 0);
      assert.equal(report.verification.matchedSourceCount, 0);
      assert(report.verification.fields.every(field => field.status === 'missing' && field.statements.length === 0));
      assert(!markdown.includes(invalid));
    }
  }
  const valid = reportFor(target); valid.trace = [{ text: '合法补充字符😀' }];
  assert.equal(preparePaidReport(valid).report, valid);
});
