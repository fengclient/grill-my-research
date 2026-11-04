import { setTimeout as sleep } from 'node:timers/promises';

// Provider list price checked on 2026-11-04. This is an estimate, not an invoice.
export const PRICING = Object.freeze({
  currency: 'CNY',
  perThousandBillableResponses: 5,
  source: 'https://api-docs.deepseek.com/zh-cn/guides/search/#计费',
});

export class DeepSeekError extends Error {
  constructor(code, message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'DeepSeekError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function invalid(message) {
  return new DeepSeekError('INVALID_INPUT', message);
}

function text(value, name, maxLength) {
  if (typeof value !== 'string' || !value.trim() || [...value].length > maxLength) {
    throw invalid(`${name} must contain 1–${maxLength} Unicode characters.`);
  }
  return value;
}

function integer(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalid(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
}

function aborted() {
  return new DeepSeekError('ABORTED', 'DeepSeek request was cancelled.');
}

export class DeepSeekClient {
  #key;
  #transport;
  #timeoutMs;
  #maxRetries;
  #retryDelayMs;
  #maxRequests;
  #usage = {
    search: { attempts: 0, successfulResponses: 0, billableResponses: 0, uncertainOutcomes: 0 },
    fetch: { attempts: 0, successfulResponses: 0, billableResponses: 0, uncertainOutcomes: 0 },
  };

  constructor({
    apiKey = process.env.DEEPSEEK_API_KEY,
    fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
    maxRetries = 2,
    retryDelayMs = 300,
    maxRequests = Infinity,
  } = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) {
      throw new DeepSeekError('MISSING_API_KEY', 'Set DEEPSEEK_API_KEY in the process environment.');
    }
    if (typeof fetchImpl !== 'function') throw invalid('fetchImpl must be a function.');
    integer(timeoutMs, 'timeoutMs', 1, 2_147_483_647);
    integer(maxRetries, 'maxRetries', 0, 5);
    integer(retryDelayMs, 'retryDelayMs', 0, 30_000);
    if (maxRequests !== Infinity) integer(maxRequests, 'maxRequests', 1, Number.MAX_SAFE_INTEGER);
    this.#key = apiKey.trim();
    this.#transport = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#maxRetries = maxRetries;
    this.#retryDelayMs = retryDelayMs;
    this.#maxRequests = maxRequests;
  }

  get usage() {
    const counts = structuredClone(this.#usage);
    const billable = counts.search.billableResponses + counts.fetch.billableResponses;
    return { ...counts, estimatedCostCny: billable * PRICING.perThousandBillableResponses / 1000 };
  }

  async search(query, { count = 10, needContent = true, originalQuestion, localization, signal } = {}) {
    text(query, 'query', 128);
    integer(count, 'count', 1, 50);
    if (typeof needContent !== 'boolean') throw invalid('needContent must be a boolean.');
    const body = { query, count, need_content: needContent };
    if (originalQuestion !== undefined && originalQuestion !== null) {
      body.ori_question = text(originalQuestion, 'originalQuestion', 128);
    }
    if (localization !== undefined) {
      if (typeof localization !== 'string') throw invalid('localization must be a string.');
      body.localization = localization;
    }
    return this.#request('search', body, signal);
  }

  async fetch(url, { signal } = {}) {
    text(url, 'url', 8192);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw invalid('url must be an absolute HTTP(S) URL without credentials.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
      throw invalid('url must be an absolute HTTP(S) URL without credentials.');
    }
    return this.#request('fetch', { url }, signal);
  }

  async #request(operation, body, signal) {
    const usage = this.#usage[operation];
    for (let retry = 0; retry <= this.#maxRetries; retry += 1) {
      if (signal?.aborted) throw aborted();
      const attempts = this.#usage.search.attempts + this.#usage.fetch.attempts;
      if (attempts >= this.#maxRequests) {
        throw new DeepSeekError('REQUEST_BUDGET_EXCEEDED', 'DeepSeek request budget exhausted, including retries.');
      }
      const timeout = AbortSignal.timeout(this.#timeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      usage.attempts += 1;
      let response;
      let data;
      let failure;
      try {
        response = await this.#transport(`https://api.deepseek.com/v1/tools/${operation}`, {
          method: 'POST',
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${this.#key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: requestSignal,
        });
        if (response.ok) {
          data = await response.json();
          const valid = operation === 'search'
            ? Array.isArray(data?.results) && data.results.every(item => item && typeof item.url === 'string' && typeof item.content === 'string')
            : typeof data?.title === 'string' && typeof data?.content === 'string';
          if (!valid) throw new DeepSeekError('INVALID_RESPONSE', 'DeepSeek returned an invalid response.');
        }
      } catch (error) {
        // A disconnected or unreadable response does not prove the provider did no work.
        usage.uncertainOutcomes += 1;
        if (signal?.aborted) throw aborted();
        if (error instanceof DeepSeekError) throw error;
        if (error instanceof SyntaxError) {
          throw new DeepSeekError('INVALID_RESPONSE', 'DeepSeek returned invalid JSON.');
        }
        failure = timeout.aborted
          ? new DeepSeekError('TIMEOUT', 'DeepSeek request timed out.', { retryable: true })
          : new DeepSeekError('NETWORK_ERROR', 'DeepSeek request failed in transit.', { retryable: true });
      }
      if (response?.ok && !failure) {
        usage.successfulResponses += 1;
        const billable = operation === 'search' ? data.results.length > 0 : data.content.trim().length > 0;
        if (billable) usage.billableResponses += 1;
        return data;
      }
      if (!failure) {
        // Discard error bodies, including upstream messages that may echo credentials.
        await response.body?.cancel().catch(() => {});
        const status = response.status;
        failure = new DeepSeekError('HTTP_ERROR', `DeepSeek returned HTTP ${status}.`, {
          status,
          retryable: status === 408 || status === 429 || status >= 500,
        });
      }
      if (!failure.retryable || retry === this.#maxRetries) throw failure;
      let delayMs = this.#retryDelayMs * 2 ** retry;
      const retryAfter = response?.headers.get('retry-after');
      if (retryAfter) {
        const seconds = Number(retryAfter);
        const requestedMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(requestedMs)) delayMs = Math.max(delayMs, requestedMs);
      }
      // Leave long waits to the task scheduler, retaining the HTTP error for callers.
      if (delayMs > 30_000) throw failure;
      try {
        await sleep(delayMs, undefined, { signal });
      } catch {
        throw aborted();
      }
    }
  }
}
