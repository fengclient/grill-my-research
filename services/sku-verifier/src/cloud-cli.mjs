import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTarget } from './evidence.mjs';
import { createOutputDirectory, saveReport } from './report.mjs';

const execute = promisify(execFile);
async function invokeCli(args) {
  try {
    const { stdout } = await execute('vefaas', args, { encoding: 'utf8', timeout: 900_000, maxBuffer: 16_000_000 });
    return JSON.parse(stdout);
  } catch { throw new Error('CLOUD_CLI_FAILED'); }
}

export async function main(args, { call = invokeCli, token = process.env.SKU_WORKER_TOKEN,
  stdout = console.log, stderr = console.error } = {}) {
  const [input, output, config = 'cloud/deployment.local.json', ...extra] = args;
  if (!input || !output || extra.length) {
    stderr('Usage: node src/cloud-cli.mjs <target.json> <new-output-directory> [deployment.json]');
    return 1;
  }
  let directory;
  let invoked = false;
  try {
    const target = validateTarget(JSON.parse(await readFile(input, 'utf8')));
    const deployment = JSON.parse(await readFile(config, 'utf8'));
    if (!/^\d+$/.test(deployment.accountId) || !/^[a-z0-9-]+$/.test(deployment.region)
      || !/^[a-zA-Z0-9_-]+$/.test(deployment.functionId) || typeof token !== 'string' || token.length < 32) {
      throw new Error('INVALID_CLOUD_CONFIG');
    }
    directory = await createOutputDirectory(output);
    const identity = await call(['whoami', '--region', deployment.region, '-o', 'json']);
    if (!identity.ok || identity.data?.account_id !== deployment.accountId) throw new Error('CLOUD_ACCOUNT_MISMATCH');
    const request = { method: 'POST', path: '/verify', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
    }, data: target };
    invoked = true;
    // CLI 0.3.2 accepts JSON values here, but not @files or stdin. Never log args/errors.
    const result = await call(['fn', 'invoke', '--id', deployment.functionId, '--requestJson', JSON.stringify(request),
      '--region', deployment.region, '-o', 'json']);
    if (!result.ok) throw new Error('CLOUD_INVOKE_FAILED');
    const { statusCode, response, stats, instanceName } = result.data;
    await writeFile(resolve(directory, 'invocation.json'), JSON.stringify({ statusCode, stats, instanceName }, null, 2) + '\n');
    const report = JSON.parse(response);
    if (report.schema !== 'sku-verification-v1' || !['completed', 'failed', 'budget_exhausted'].includes(report.status)) {
      throw new Error('INVALID_CLOUD_RESPONSE');
    }
    await saveReport(directory, report);
    stdout(JSON.stringify({ directory, statusCode, status: report.status,
      identityStatus: report.verification.identityStatus, matchedSourceCount: report.verification.matchedSourceCount,
      usage: report.usage }, null, 2));
    return statusCode === 200 && report.status === 'completed' ? 0 : 1;
  } catch (error) {
    const known = ['CLOUD_CLI_FAILED', 'CLOUD_ACCOUNT_MISMATCH', 'CLOUD_INVOKE_FAILED', 'INVALID_CLOUD_CONFIG', 'INVALID_CLOUD_RESPONSE'];
    const failure = { error: known.includes(error.message) ? error.message : 'CLOUD_TASK_OR_IO_ERROR',
      uncertainOutcome: invoked, automaticRetry: false };
    if (directory) await writeFile(resolve(directory, 'failure.json'), JSON.stringify(failure, null, 2) + '\n').catch(() => {});
    stderr(JSON.stringify(failure));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
