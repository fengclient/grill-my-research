export const FIELDS = Object.freeze({
  ingredients: '配料', nutrition: '营养', shelfLife: '保质期',
  storage: '储存条件', manufacturer: '生产商', claims: '来源声明', offers: '渠道报价与条件',
});

export function normalize(value) {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

function quantity(value, unit) {
  const units = { ml: ['volume', 1], 毫升: ['volume', 1], l: ['volume', 1000], 升: ['volume', 1000],
    g: ['mass', 1], 克: ['mass', 1], kg: ['mass', 1000], 千克: ['mass', 1000] };
  const conversion = units[normalize(unit)];
  if (!Number.isFinite(value) || value <= 0 || !conversion) throw new Error('Invalid net quantity.');
  return { dimension: conversion[0], value: value * conversion[1] };
}

export function validateTarget(target) {
  for (const field of ['brand', 'productName']) {
    if (typeof target?.[field] !== 'string' || !target[field].trim() || target[field].length > 60) {
      throw new Error(`Target ${field} must contain 1–60 characters.`);
    }
  }
  quantity(target.netQuantity?.value, target.netQuantity?.unit ?? '');
  for (const field of ['version', 'packageForm']) {
    if (target[field] != null && (typeof target[field] !== 'string' || !target[field].trim())) {
      throw new Error(`Target ${field} must be a nonempty string or null.`);
    }
  }
  if (!Array.isArray(target.officialDomains) || target.officialDomains.some(domain =>
    typeof domain !== 'string' || !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(domain))) {
    throw new Error('Target officialDomains must be an array of explicit domain names.');
  }
  return target;
}

// The model selects line ranges; only server-held source text becomes a quote.
export function materializeCandidates(sources, candidates) {
  if (!Array.isArray(candidates) || candidates.length > 30) throw new Error('Invalid evidence candidates.');
  return candidates.map(candidate => {
    const source = sources.find(item => item.id === candidate?.sourceId);
    const lines = source?.content.split('\n') ?? [];
    function excerpt(range) {
      if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isInteger)
        || range[0] < 1 || range[1] < range[0] || range[1] > lines.length) return '';
      return lines.slice(range[0] - 1, range[1]).join('\n');
    }
    if (!Array.isArray(candidate?.facts) || candidate.facts.length > 30) throw new Error('Invalid fact candidates.');
    return { sourceId: candidate.sourceId, productQuote: excerpt(candidate.productLines),
      facts: candidate.facts.map(fact => {
        const contained = fact?.lines?.[0] >= candidate.productLines?.[0] && fact?.lines?.[1] <= candidate.productLines?.[1];
        return { field: fact?.field, quote: contained ? excerpt(fact.lines) : '' };
      }) };
  });
}

function identityReason(target, quote) {
  const normalized = normalize(quote);
  for (const field of ['brand', 'productName', 'version', 'packageForm']) {
    if (target[field] && !normalized.includes(normalize(target[field]))) return `未在产品上下文找到目标 ${field}`;
  }
  const expected = quantity(target.netQuantity.value, target.netQuantity.unit);
  const observed = [];
  const quantityText = quote.normalize('NFKC');
  const pattern = /(\d+(?:\.\d+)?)\s*(毫升|千克|ml|kg|升|克|l|g)(?![a-z])/giu;
  for (const match of quantityText.matchAll(pattern)) {
    const prefix = quantityText.slice(Math.max(0, match.index - 12), match.index);
    if (/(?:每|per\s*|\/)\s*$/iu.test(prefix)) continue;
    if (/\d\s*[-–~至]\s*$/u.test(prefix)) return '范围值不能证明精确净含量';
    if (Number(match[1]) === 0) continue;
    const candidate = quantity(Number(match[1]), match[2]);
    if (candidate.dimension === expected.dimension) observed.push(candidate.value);
  }
  if (!observed.some(value => Math.abs(value - expected.value) < 1e-8)) return '未在产品上下文找到目标净含量';
  if (observed.some(value => Math.abs(value - expected.value) >= 1e-8)) return '产品上下文含不同规格，需要人工核对';
  return null;
}

export function verifyCandidates(target, sources, candidates) {
  if (!Array.isArray(candidates) || candidates.length > 30) throw new Error('Invalid evidence candidates.');
  const matches = [];
  const facts = [];
  const rejected = [];
  for (const candidate of candidates) {
    const source = sources.find(item => item.id === candidate?.sourceId);
    const quote = candidate?.productQuote;
    let reason;
    if (!source) reason = '引用了未知来源';
    else if (typeof quote !== 'string' || !quote.trim() || quote.length > 2400 || !normalize(source.content).includes(normalize(quote))) {
      reason = '产品上下文不是已取得正文中的原文，或范围过长';
    } else reason = identityReason(target, quote);
    if (reason) {
      rejected.push({ sourceId: candidate?.sourceId ?? null, reason });
      continue;
    }
    matches.push({ sourceId: source.id, productQuote: quote });
    if (!Array.isArray(candidate.facts) || candidate.facts.length > 30) throw new Error('Invalid fact candidates.');
    for (const fact of candidate.facts) {
      if (!Object.hasOwn(FIELDS, fact?.field) || typeof fact?.quote !== 'string' || !fact.quote.trim()
        || fact.quote.length > 600 || !normalize(quote).includes(normalize(fact.quote))) {
        rejected.push({ sourceId: source.id, reason: '事实缺少同一产品上下文中的可追溯原文' });
        continue;
      }
      if (!facts.some(item => item.sourceId === source.id && item.field === fact.field && normalize(item.quote) === normalize(fact.quote))) {
        facts.push({ sourceId: source.id, field: fact.field, quote: fact.quote });
      }
    }
  }
  const fields = Object.entries(FIELDS).map(([field, label]) => {
    const statements = facts.filter(fact => fact.field === field);
    const variants = new Set(statements.map(fact => {
      const prefix = field === 'shelfLife' ? /^保质期:?/u : /^(?:配料表?|储存条件|储存方法|贮存条件|生产商):?/u;
      return normalize(fact.quote).replace(prefix, '');
    }));
    let status = 'missing';
    if (variants.size === 1) status = 'source_supported';
    if (variants.size > 1) status = 'review_variants';
    return { field, label, status, statements };
  });
  const domains = new Set(matches.map(match => new URL(sources.find(source => source.id === match.sourceId).url).hostname));
  const officialMatches = matches.filter(match => sources.find(source => source.id === match.sourceId).kind === 'official');
  return { identityStatus: matches.length ? 'requested_identity_supported' : 'not_established',
    matchedSourceCount: new Set(matches.map(match => match.sourceId)).size,
    matchedDomainCount: domains.size, officialMatchedSourceCount: new Set(officialMatches.map(match => match.sourceId)).size,
    matches, fields, rejected };
}
