import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { DeepSeekClient, DeepSeekError, PRICING } from './deepseek.mjs';
import { DeepSeekModel } from './model.mjs';
import { validateTarget } from './evidence.mjs';
import { verifySku } from './verify.mjs';
import { createOutputDirectory, saveReport } from './report.mjs';

const help = 'Usage: node src/cli.mjs search "query" | fetch "https://example.com/page" | verify <target.json> <new-output-directory>';

export async function main(args, { client, model, stdout = console.log, stderr = console.error } = {}) {
  const [operation, input, output, ...extra] = args;
  if (operation === '--help') {
    stdout(help);
    return 0;
  }
  if (!['search', 'fetch', 'verify'].includes(operation) || input === undefined || extra.length
    || (operation === 'verify' ? !output : output !== undefined)) {
    stderr(help);
    return 1;
  }
  try {
    if (operation === 'verify') {
      const target = validateTarget(JSON.parse(await readFile(input, 'utf8')));
      client ??= new DeepSeekClient({ maxRequests: 12 });
      model ??= new DeepSeekModel();
      const directory = await createOutputDirectory(output);
      const report = await verifySku(target, { client, model });
      await saveReport(directory, report);
      stdout(JSON.stringify({ directory, status: report.status, verification: report.verification, usage: report.usage }, null, 2));
      return report.status === 'completed' ? 0 : 1;
    }
    client ??= new DeepSeekClient({ maxRequests: 3 });
    const data = await client[operation](input);
    stdout(JSON.stringify({ data, usage: client.usage, pricing: PRICING }, null, 2));
    return 0;
  } catch (error) {
    const detail = error instanceof DeepSeekError
      ? { code: error.code, message: error.message, status: error.status, retryable: error.retryable }
      : { code: 'INVALID_TASK_OR_IO_ERROR', message: 'Check the target specification and choose a new writable output directory.' };
    stderr(JSON.stringify({ error: detail, usage: client?.usage }, null, 2));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
