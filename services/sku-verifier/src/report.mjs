import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

function escape(value) {
  return String(value).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
    .replace(/([\\`*_{}\[\]()#+.!|])/g, '\\$1');
}

export function renderReport(report) {
  const { target, verification } = report;
  const execution = { completed: '采集与证据检查完成', failed: '执行失败', budget_exhausted: '预算耗尽' };
  const fieldStatus = { missing: '未取得正文支持', source_supported: '有来源原文支持', review_variants: '来源表述存在差异，待复核' };
  const text = [
    `# ${escape(target.brand)} ${escape(target.productName)} SKU 核验`, '',
    `目标净含量 ${target.netQuantity.value} ${escape(target.netQuantity.unit)}`, '',
    `执行状态 ${execution[report.status]} · 获取时间 ${report.finishedAt}`, '',
    `请求规格${verification.matchedSourceCount ? '有来源支持' : '尚未建立匹配'} · 匹配来源 ${verification.matchedSourceCount} 个，域名 ${verification.matchedDomainCount} 个，官方精确规格来源 ${verification.officialMatchedSourceCount} 个`, '',
    '## 事实与来源原文', '',
  ];
  for (const field of verification.fields) {
    text.push(`### ${field.label}`, '', `状态 ${fieldStatus[field.status]}`, '');
    for (const statement of field.statements) text.push(`- [${statement.sourceId}] ${escape(statement.quote).replace(/\n/g, '\n  ')}`, '');
  }
  text.push('## 来源', '');
  for (const source of report.sources) {
    text.push(`- [${source.id}] ${escape(source.title)} · ${source.kind} · ${source.retrievedAt}`,
      `  <${source.url.replace(/</g, '%3C').replace(/>/g, '%3E')}>`, `  正文 SHA-256 ${source.contentSha256}`, '');
  }
  text.push('## 证据审查与缺口', '');
  for (const row of verification.rejected) text.push(`- ${escape(row.sourceId ?? 'unknown')} ${escape(row.reason)}`);
  for (const limitation of report.limitations) text.push(`- ${escape(limitation)}`);
  if (report.failure) text.push(`- 任务异常 ${report.failure.code}`);
  text.push('', '## 用量', '', '```json', JSON.stringify(report.usage, null, 2), '```', '');
  return text.join('\n');
}

export async function createOutputDirectory(output) {
  const directory = resolve(output);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory); // Exclusive: retries must choose a new directory before making paid calls.
  return directory;
}

export async function saveReport(directory, report) {
  const files = {
    'report.json': JSON.stringify(report, null, 2) + '\n',
    'report.md': renderReport(report),
  };
  for (const [name, content] of Object.entries(files)) {
    const path = resolve(directory, name);
    await writeFile(`${path}.tmp`, content, { flag: 'wx' });
    await rename(`${path}.tmp`, path);
  }
}
