import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const service = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(process.argv[2] || resolve(service, '../../dist/sku-verifier-paid'));
await mkdir(dirname(destination), { recursive: true });
await mkdir(destination);
for (const name of ['src','migrations','package.json','package-lock.json']) {
  await cp(resolve(service, name), resolve(destination, name), { recursive: true });
}
await mkdir(resolve(destination, 'scripts'));
await cp(resolve(service, 'scripts/migrate-paid.mjs'), resolve(destination, 'scripts/migrate-paid.mjs'));
const metadata = JSON.parse(await readFile(resolve(destination, 'package.json'), 'utf8'));
metadata.scripts.start = 'node src/paid-server.mjs';
await writeFile(resolve(destination, 'package.json'), JSON.stringify(metadata, null, 2) + '\n');
execFileSync('npm', ['ci','--omit=dev','--ignore-scripts','--no-fund'], { cwd: destination, stdio: 'inherit' });
const files = {};
async function inventory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.env' || entry.name.startsWith('.env.')) throw Error('Environment file found in deployment package.');
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await inventory(path);
    else if (entry.isFile()) files[relative(destination, path)] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
}
await inventory(destination);
await writeFile(resolve(destination, 'build-manifest.json'), JSON.stringify({ files }, null, 2) + '\n');
console.log(JSON.stringify({ directory: destination, files: Object.keys(files).length }));
