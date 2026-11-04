import { DeepSeekClient, DeepSeekError, PRICING } from './deepseek.mjs';

const [operation, input, ...extra] = process.argv.slice(2);
const help = 'Usage: node src/cli.mjs search "query" | fetch "https://example.com/page"';
if (operation === '--help') {
  console.log(help);
} else if (!['search', 'fetch'].includes(operation) || input === undefined || extra.length) {
  console.error(help);
  process.exitCode = 1;
} else {
  let client;
  try {
    // One invocation performs one operation, allowing at most two retries.
    client = new DeepSeekClient({ maxRequests: 3 });
    const data = await client[operation](input);
    console.log(JSON.stringify({ data, usage: client.usage, pricing: PRICING }, null, 2));
  } catch (error) {
    const detail = error instanceof DeepSeekError
      ? { code: error.code, message: error.message, status: error.status, retryable: error.retryable }
      : { code: 'UNEXPECTED_ERROR', message: 'Unexpected client failure.' };
    console.error(JSON.stringify({ error: detail, usage: client?.usage }, null, 2));
    process.exitCode = 1;
  }
}
