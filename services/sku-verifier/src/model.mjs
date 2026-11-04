import { DeepSeekError } from './deepseek.mjs';

export class DeepSeekModel {
  #key;
  #transport;
  #model;
  #usage = { attempts: 0, promptTokens: 0, completionTokens: 0, uncertainOutcomes: 0 };

  constructor({ apiKey = process.env.DEEPSEEK_API_KEY, model = process.env.DEEPSEEK_MODEL || 'deepseek-flash', fetchImpl = globalThis.fetch } = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) {
      throw new DeepSeekError('MISSING_API_KEY', 'Set DEEPSEEK_API_KEY in the process environment.');
    }
    if (typeof model !== 'string' || !model.trim()) throw new Error('A model name is required.');
    this.#key = apiKey.trim();
    this.#model = model;
    this.#transport = fetchImpl;
  }

  get usage() { return { model: this.#model, ...this.#usage }; }

  async next(system, state, { signal } = {}) {
    if (signal?.aborted) throw new DeepSeekError('ABORTED', 'Model request cancelled.');
    this.#usage.attempts += 1;
    let response;
    let data;
    try {
      const timeout = AbortSignal.timeout(90_000);
      response = await this.#transport('https://api.deepseek.com/chat/completions', {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${this.#key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.#model, thinking: { type: 'disabled' }, max_tokens: 6000,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(state) }],
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new DeepSeekError('MODEL_HTTP_ERROR', `Model returned HTTP ${response.status}.`, { status: response.status });
      }
      data = await response.json();
    } catch (error) {
      if (error instanceof DeepSeekError) throw error;
      this.#usage.uncertainOutcomes += 1;
      throw new DeepSeekError('MODEL_NETWORK_ERROR', 'Model response could not be obtained.');
    }
    const usage = data.usage;
    if (Number.isInteger(usage?.prompt_tokens)) this.#usage.promptTokens += usage.prompt_tokens;
    if (Number.isInteger(usage?.completion_tokens)) this.#usage.completionTokens += usage.completion_tokens;
    const choice = data.choices?.[0];
    if (choice?.finish_reason !== 'stop' || !choice.message?.content?.trim()) {
      throw new DeepSeekError('MODEL_INVALID_OUTPUT', 'Model output was empty, interrupted or truncated.');
    }
    try {
      return JSON.parse(choice.message.content);
    } catch {
      throw new DeepSeekError('MODEL_INVALID_OUTPUT', 'Model output was not valid JSON.');
    }
  }
}
