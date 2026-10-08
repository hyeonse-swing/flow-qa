import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = process.cwd();
const expected = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const npmCLI = process.env.npm_execpath;
assert.ok(npmCLI, 'Run via npm run smoke:package.');
const temp = await mkdtemp(path.join(tmpdir(), 'flowqa-package-'));
const artifacts = path.join(root, 'output', 'package');
await mkdir(artifacts, { recursive: true });
function command(args, cwd, options = {}) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 180_000, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${args[0]} failed: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
let child;
let stopped;
let report;
try {
  const supplied = process.env.FLOWQA_PACKAGE_SPEC;
  let packageSpec = supplied;
  if (!packageSpec) {
    const packed = command([npmCLI, 'pack', '--json', '--ignore-scripts', '--pack-destination', temp], root);
    packageSpec = path.join(temp, JSON.parse(packed)[0].filename);
  }
  const consumer = path.join(temp, 'consumer');
  await mkdir(consumer);
  await writeFile(path.join(consumer, 'package.json'), '{"name":"flowqa-consumer-smoke","private":true}');
  // A consumer must not need Git to install the bundled design system.
  const guards = path.join(temp, 'no-git'); await mkdir(guards);
  await writeFile(path.join(guards, 'git'), '#!/bin/sh\necho "Git must not run during consumer installation" >&2\nexit 93\n', { mode: 0o755 });
  command([npmCLI, 'install', '--omit=dev', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', packageSpec], consumer, {
    env: { ...process.env, PATH: `${guards}${path.delimiter}${process.env.PATH}` },
  });
  const installed = path.join(consumer, 'node_modules', '@ihyeon', 'flow-qa');
  const bin = path.join(installed, 'dist', 'bin', 'flow-qa.mjs');
  const metadata = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(metadata.name, expected.name, 'Installed package name must match this release.');
  assert.equal(metadata.version, expected.version, 'Installed package version must match this release.');
  assert.match(command([bin, '--help'], consumer), /Usage:/);
  assert.match(command([bin, '--help', '--lang', 'ko'], consumer), /사용법/);
  command([bin, 'init', 'workspace'], consumer);
  const doctor = command([bin, 'doctor', '--workspace', 'workspace'], consumer);
  assert.match(doctor, /e2e/);
  assert.match(command([bin, 'browser', 'install', '--help'], consumer), /browser install/);
  command([bin, 'validate', 'cases/task-flow.json', '--workspace', 'workspace'], consumer);
  child = spawn(process.execPath, [bin, 'ui', '--demo', '--port', '0'], { cwd: consumer, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  stopped = new Promise(resolve => child.once('exit', resolve));
  const deadline = Date.now() + 15_000;
  let url;
  while (!url && Date.now() < deadline && child.exitCode === null) {
    url = output.match(/Flow QA: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (!url) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(url, `Installed UI did not start: ${errors}`);
  const get = async route => { const response = await fetch(url + route); assert.equal(response.status, 200, route); return response; };
  const html = await (await get('/')).text();
  assert.match(html, /Flow QA/);
  assert.match(html, /<html lang="en"/);
  await get('/i18n.js');
  await get('/design-system/tokens.css'); await get('/design-system/preferences.js'); await get('/fonts/dm-sans.woff2');
  const state = await (await get('/api/state')).json();
  const suite = await (await get('/api/suite?file=task-flow.json')).json();
  const response = await fetch(url + '/api/run', { method: 'POST', headers: { 'content-type': 'application/json', 'x-flowqa-token': state.csrfToken }, body: JSON.stringify({ suite: 'task-flow.json', suiteHash: suite.suiteHash, targetName: 'demo', targetURL: state.targets[0].url }) });
  assert.equal(response.status, 202);
  let finalState;
  const runDeadline = Date.now() + 90_000;
  do {
    await new Promise(resolve => setTimeout(resolve, 500));
    finalState = await (await get('/api/state')).json();
  } while (finalState.active && Date.now() < runDeadline);
  assert.equal(finalState.active, null, 'Installed demo timed out.');
  assert.ok(finalState.lastRunId, finalState.lastError);
  report = (await (await get('/api/report?runId=' + finalState.lastRunId)).json()).report;
  assert.equal(report.status, 'passed', JSON.stringify(report.errors));
  assert.equal(report.cases.filter(item => item.status === 'passed').length, 3);
  const evidence = { package: metadata.name, version: metadata.version, source: supplied ? 'npm registry' : 'packed tarball', node: process.version, platform: process.platform, gitRequired: false, tests: 3, status: report.status, modelCalls: 0, verifiedAt: new Date().toISOString() };
  await writeFile(path.join(artifacts, supplied ? 'registry-smoke.json' : 'tarball-smoke.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 12_000);
    await stopped; clearTimeout(force);
  }
  await rm(temp, { recursive: true, force: true });
}
