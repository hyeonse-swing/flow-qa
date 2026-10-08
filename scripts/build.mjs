import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
const compiler = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));
const result = spawnSync(process.execPath, [compiler, '--project', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await cp(new URL('../src/ui/public/', import.meta.url), new URL('../dist/src/ui/public/', import.meta.url), { recursive: true });
await mkdir(new URL('../dist/bin/', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/bin/flow-qa.mjs', import.meta.url), '#!/usr/bin/env node\nimport { main } from "../src/cli.js";\nawait main(process.argv.slice(2));\n', { mode: 0o755 });
console.log('Built CLI, local UI, and demo into dist/.');
