import { createHash } from 'node:crypto';
import { renderReport } from './report.mjs';
import { normalize, verifyCandidates } from './evidence.mjs';

// PostgreSQL jsonb adds whitespace to compact JSON; this leaves room within its 2 MiB check.
export const PAID_REPORT_BYTES = 1_048_576;
const bytes = value => Buffer.byteLength(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const describe = value => ({ bytes: bytes(value), sha256: hash(value) });

function unsupportedUnicode(value) {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') {
      for (let index = 0; index < item.length; index++) {
        const code = item.charCodeAt(index);
        if (code === 0 || (code >= 0xdc00 && code <= 0xdfff)) return true;
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = item.charCodeAt(++index);
          if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        }
      }
    } else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) pending.push(key, child);
    }
  }
  return false;
}

export function preparePaidReport(original, target = original.target) {
  const originalJson = JSON.stringify(original);
  if (unsupportedUnicode(original)) {
    const now = new Date().toISOString();
    const report = {
      schema: 'sku-verification-v1', status: 'failed', target, startedAt: now, finishedAt: now,
      verification: verifyCandidates(target, [], []), sources: [], trace: [], usage: {},
      failure: { code: 'REPORT_UNSUPPORTED_UNICODE', message: 'Collected report contains Unicode that durable storage cannot represent.' },
      limitations: ['采集结果包含无法安全存储的 Unicode，原始报告与引文未交付；未修改引文后声称核验成功。'],
      delivery: { truncated: true, reason: 'UNSUPPORTED_UNICODE', originalReport: describe(originalJson),
        omitted: { sources: original.sources.length, sourceContents: original.sources.filter(source => typeof source.content === 'string').length,
          traceSteps: original.trace.length, statements: original.verification.fields.reduce((sum, field) => sum + field.statements.length, 0),
          matches: original.verification.matches.length, rejected: original.verification.rejected.length } },
    };
    return { report, markdown: renderReport(report) };
  }
  let report = original;
  let markdown = renderReport(report);
  const fits = () => bytes(JSON.stringify(report)) <= PAID_REPORT_BYTES && bytes(markdown) <= PAID_REPORT_BYTES;
  if (fits()) return { report, markdown };

  report = structuredClone(original);
  report.delivery = { truncated: true, originalReport: describe(originalJson), omitted: { sourceContents: 0, traceSteps: 0, statements: 0, rejected: 0 } };
  report.limitations.push('报告交付体积受限，省略项与原始报告哈希见 JSON 的 delivery；保留的引文完整且未更改行号。');
  for (const source of report.sources) {
    if (typeof source.content === 'string') {
      source.contentOmitted = describe(source.content);
      delete source.content;
      report.delivery.omitted.sourceContents++;
    }
    for (const [field, limit] of [['title', 4096], ['url', 8192], ['publishedAt', 128]]) {
      const value = typeof source[field] === 'string' ? source[field] : JSON.stringify(source[field] ?? null);
      if (bytes(JSON.stringify(source[field] ?? null)) > limit) {
        source[`${field}Omitted`] = describe(value);
        source[field] = field === 'publishedAt' ? null : '';
      }
    }
  }
  if (bytes(JSON.stringify(report.usage)) > 65536) {
    report.delivery.omitted.usage = describe(JSON.stringify(report.usage));
    report.usage = {};
  }
  markdown = renderReport(report);
  if (fits()) return { report, markdown };

  report.delivery.omitted.traceSteps = report.trace.length;
  report.trace = [];
  markdown = renderReport(report);
  const lists = report.verification.fields.map(field => {
    const variant = statement => normalize(statement.quote).replace(field.field === 'shelfLife' ? /^保质期:?/u : /^(?:配料表?|储存条件|储存方法|贮存条件|生产商):?/u, '');
    const first = field.statements[0];
    const different = first && field.status === 'review_variants' ? field.statements.find(statement => variant(statement) !== variant(first)) : null;
    return { items: field.statements, kind: 'statements', field, originalCount: field.statements.length, keep: new Set([first, different]) };
  });
  lists.push({ items: report.verification.rejected, kind: 'rejected', keep: new Set() });
  while (!fits()) {
    const removable = lists.map(list => ({ list, items: list.items.filter(item => !list.keep.has(item)) }))
      .filter(candidate => candidate.items.length).sort((a, b) => bytes(JSON.stringify(b.items)) - bytes(JSON.stringify(a.items)))[0];
    if (!removable) throw Error('INVALID_REPORT_SHAPE');
    const { list, items } = removable;
    const removed = new Set(items.slice(-Math.ceil(items.length / 2)));
    list.items.splice(0, list.items.length, ...list.items.filter(item => !removed.has(item)));
    report.delivery.omitted[list.kind] += removed.size;
    if (list.field) list.field.delivery = { originalStatementCount: list.originalCount, omittedStatements: list.originalCount - list.items.length };
    markdown = renderReport(report);
  }
  return { report, markdown };
}
