import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

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
let browser;
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
  const shim = path.join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'flow-qa.cmd' : 'flow-qa');
  assert.ok((await stat(shim)).isFile(), 'npm must install the documented flow-qa command.');
  if (process.platform !== 'win32') assert.equal(await realpath(shim), await realpath(bin));
  const cli = (...args) => command([npmCLI, 'exec', '--offline', '--no', '--', 'flow-qa', ...args], consumer);
  assert.match(cli('--help'), /Usage:/);
  assert.match(cli('--help', '--lang', 'ko'), /사용법/);
  cli('init', 'workspace');
  const doctor = cli('doctor', '--workspace', 'workspace');
  assert.match(doctor, /e2e/);
  assert.match(doctor, /@e2e-dev\/mobile: 0\./);
  assert.match(cli('browser', 'install', '--help'), /browser install/);
  cli('validate', 'cases/task-flow.json', '--workspace', 'workspace');
  // Installed consumers can author mobile cases before any app or device is configured.
  cli('plan', 'flows/task-flow.md', '--platform', 'mobile', '--prompt-only', '--workspace', 'workspace');
  const mobileSuite = {
    schemaVersion: 'flow-qa/suite-1', platform: 'mobile', id: 'mobile-smoke', title: 'Mobile package smoke',
    requirements: [{ id: 'REQ-1', text: 'The installed app opens to its home screen.' }],
    cases: [{ id: 'CASE-1', title: 'Home screen', requirementIds: ['REQ-1'], steps: [
      { type: 'launchApp' }, { type: 'assertVisible', locator: { by: 'text', value: 'Home' } },
    ] }],
  };
  await writeFile(path.join(consumer, 'workspace', 'cases', 'mobile-smoke.json'), JSON.stringify(mobileSuite));
  cli('validate', 'cases/mobile-smoke.json', '--workspace', 'workspace');
  cli('generate', 'cases/mobile-smoke.json', '--out', 'generated/mobile-smoke.test.ts', '--workspace', 'workspace');
  assert.match(await readFile(path.join(consumer, 'workspace', 'generated', 'mobile-smoke.test.ts'), 'utf8'), /@e2e-dev\/mobile/);
  cli('connect', 'my-ios', '--platform', 'ios', '--bundle-id', 'com.example.app', '--device', 'QA iPhone', '--workspace', 'workspace');
  cli('connect', 'my-android', '--platform', 'android', '--bundle-id', 'com.example.app', '--device', 'emulator-5554', '--workspace', 'workspace');
  assert.match(cli('doctor', '--workspace', 'workspace'), /Mobile target my-android:/);
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
  // Exercise the compiled comparison endpoint with two reports from real runs.
  const rerun = await fetch(url + '/api/run', { method: 'POST', headers: { 'content-type': 'application/json', 'x-flowqa-token': state.csrfToken }, body: JSON.stringify({ suite: 'task-flow.json', suiteHash: suite.suiteHash, targetName: 'demo', targetURL: state.targets[0].url }) });
  assert.equal(rerun.status, 202);
  const comparisonDeadline = Date.now() + 90_000;
  do {
    await new Promise(resolve => setTimeout(resolve, 500));
    finalState = await (await get('/api/state')).json();
  } while (finalState.active && Date.now() < comparisonDeadline);
  assert.equal(finalState.active, null, 'Second installed demo timed out.');
  assert.ok(finalState.lastRunId && finalState.lastRunId !== report.runId, finalState.lastError);
  const comparisonRoute = '/api/comparison?' + new URLSearchParams({ baseline: report.runId, current: finalState.lastRunId });
  const compared = await (await get(comparisonRoute)).json();
  assert.equal(compared.comparison.schemaVersion, 'flow-qa/comparison-1');
  assert.equal(compared.comparison.baseline.runId, report.runId);
  assert.equal(compared.comparison.current.runId, finalState.lastRunId);
  assert.equal(compared.comparison.current.status, 'passed');
  assert.deepEqual(compared.comparison.counts, { 'newly-failed': 0, 'now-passed': 0, changed: 0, unchanged: 3, added: 0, missing: 0 });
  assert.deepEqual(compared.comparison.warnings, []);
  assert.ok(compared.markdown.includes(report.runId) && compared.markdown.includes(finalState.lastRunId));
  const koreanComparison = await fetch(url + comparisonRoute, { headers: { 'Accept-Language': 'ko' } });
  assert.equal(koreanComparison.status, 200);
  assert.match((await koreanComparison.json()).markdown, /비교/);
  // A synthetic failed report exercises preparation in the installed package;
  // the prepared selection then performs a real browser run.
  const failedFixture = { ...report, runId: randomUUID(), status: 'failed', cases: report.cases.map(item => ({ ...item, status: item.id === 'TC-002' ? 'failed' : 'passed' })) };
  const repeatedCase = failedFixture.cases.find(item => item.id === 'TC-003');
  repeatedCase.attempts = [...repeatedCase.attempts, { ...repeatedCase.attempts[0], index: 1 }, { ...repeatedCase.attempts[0], index: 2 }];
  const fixtureDir = path.join(consumer, '.flowqa/ui-demo-en/.flowqa/runs', failedFixture.runId);
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(path.join(fixtureDir, 'qa-report.json'), JSON.stringify(failedFixture));
  await writeFile(path.join(fixtureDir, 'qa-report.md'), '# Synthetic failed report for package verification\n');
  // Exercise report exploration through the installed UI, preserving complete exports.
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#connection-label').textContent.includes('connected'));
  await page.locator('[data-view="history"]').click();
  await page.locator(`#history-list [data-run-id="${failedFixture.runId}"] [data-action="view-report"]`).click();
  await page.waitForFunction(id => document.querySelector('#report-heading').textContent.includes(id), failedFixture.runId);
  await page.locator('#report-case-sort').selectOption('duration-desc');
  const sortedCaseIds = [...failedFixture.cases].sort((a, b) => b.attempts.reduce((sum, item) => sum + item.durationMs, 0) - a.attempts.reduce((sum, item) => sum + item.durationMs, 0)).map(item => item.id);
  assert.deepEqual((await page.locator('#report-content .case-report h3').allTextContents()).map(heading => heading.split(' · ')[0]), sortedCaseIds);
  await page.locator('#report-case-sort').selectOption('attempts-desc');
  assert.deepEqual((await page.locator('#report-content .case-report h3').allTextContents()).map(heading => heading.split(' · ')[0]), ['TC-003', 'TC-001', 'TC-002']);
  const downloadIds = async () => {
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download visible case IDs', exact: true }).click();
    const file = await pending;
    assert.equal(file.suggestedFilename(), `${failedFixture.runId}-case-ids.txt`);
    return readFile(await file.path(), 'utf8');
  };
  await page.locator('#report-case-status').selectOption('passed');
  assert.equal(await downloadIds(), 'TC-003\nTC-001\n');
  const repeated = page.getByRole('checkbox', { name: 'At least 2 attempts', exact: true });
  await repeated.check();
  assert.equal(await downloadIds(), 'TC-003\n', 'The installed UI includes a case with three recorded attempts.');
  await page.locator('#report-case-status').selectOption('failed-error');
  assert.equal(await page.locator('#report-content .case-report').count(), 0);
  assert.equal(await page.locator('#report-case-ids-download').isDisabled(), true);
  await repeated.uncheck();
  assert.equal(await downloadIds(), 'TC-002\n');
  assert.equal(await page.locator('#report-content .case-report').count(), 1);
  assert.match(await page.locator('#report-content .case-report h3').textContent(), / · 1 attempt$/);
  assert.equal(await page.locator('#report-content .case-attempt-time').textContent(), `Total attempt time: ${failedFixture.cases.find(item => item.id === 'TC-002').attempts[0].durationMs}ms`);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    async writeText(text) { window.copiedCaseId = text; }
  } }));
  await page.getByRole('button', { name: 'Copy case ID TC-002', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.case-id-copy-status').textContent === 'Case ID copied.');
  assert.equal(await page.evaluate(() => window.copiedCaseId), 'TC-002');
  await page.locator('#report-case-search').fill('TC-003');
  assert.equal(await page.locator('#report-content .case-report').count(), 0);
  assert.equal(await page.locator('#report-case-ids-download').isDisabled(), true);
  const fullDownload = page.waitForEvent('download');
  await page.locator('#report-json').click();
  const downloadedReport = JSON.parse(await readFile(await (await fullDownload).path(), 'utf8'));
  assert.deepEqual(downloadedReport.cases, failedFixture.cases);
  await page.locator('#report-case-reset').click();
  assert.equal(await page.locator('#report-content .case-report').count(), 3);
  assert.equal(await page.locator('#report-case-sort').inputValue(), 'recorded');
  assert.deepEqual((await page.locator('#report-content .case-report h3').allTextContents()).map(heading => heading.split(' · ')[0]), failedFixture.cases.map(item => item.id));
  await browser.close(); browser = null;
  const prepared = await (await get('/api/rerun?runId=' + failedFixture.runId)).json();
  assert.equal(prepared.originRunId, failedFixture.runId);
  assert.equal(prepared.file, 'task-flow.json');
  assert.deepEqual(prepared.caseIds, ['TC-002']);
  assert.equal(prepared.targetMatches, true);
  assert.equal((await (await get('/api/state')).json()).active, null, 'Preparation never starts a run.');
  const partialRun = await fetch(url + '/api/run', { method: 'POST', headers: { 'content-type': 'application/json', 'x-flowqa-token': state.csrfToken }, body: JSON.stringify({ suite: prepared.file, suiteHash: prepared.suiteHash, targetName: prepared.targetName, targetFingerprint: prepared.targetFingerprint, caseIds: prepared.caseIds }) });
  assert.equal(partialRun.status, 202);
  const partialDeadline = Date.now() + 90_000;
  do {
    await new Promise(resolve => setTimeout(resolve, 500));
    finalState = await (await get('/api/state')).json();
  } while (finalState.active && Date.now() < partialDeadline);
  assert.equal(finalState.active, null, 'Installed selected run timed out.');
  const partial = await (await get('/api/report?runId=' + finalState.lastRunId)).json();
  assert.equal(partial.report.status, 'passed');
  assert.equal(partial.report.suiteHash, report.suiteHash);
  assert.deepEqual(partial.report.selection, { caseIds: ['TC-002'], totalCases: 3 });
  assert.deepEqual(partial.report.cases.map(item => item.id), ['TC-002']);
  assert.match(partial.markdown, /[Ss]elected|[Pp]artial/);
  const partialComparison = await (await get('/api/comparison?' + new URLSearchParams({ baseline: report.runId, current: partial.report.runId }))).json();
  assert.ok(partialComparison.comparison.warnings.includes('partial-run'));
  assert.ok(partialComparison.comparison.warnings.includes('selection-changed'));
  assert.equal(partialComparison.comparison.counts.missing, 2);
  assert.equal(partialComparison.comparison.counts.unchanged, 1);
  // Old report search must work beyond the recent-50 state summary after install.
  let oldestId; let olderCurrentId;
  for (let index = 0; index < 55; index++) {
    const runId = randomUUID();
    if (index === 0) oldestId = runId;
    if (index === 1) olderCurrentId = runId;
    const dir = path.join(consumer, '.flowqa/ui-demo-en/.flowqa/runs', runId);
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'qa-report.json'), JSON.stringify({ ...failedFixture, runId, suiteId: index < 2 ? 'archived-comparison' : `archived-fixture-${index}`, startedAt: at.toISOString(), finishedAt: at.toISOString() }));
    await utimes(dir, at, at);
  }
  assert.equal((await (await get('/api/state')).json()).runs.some(item => item.runId === oldestId), false);
  const archived = await (await get('/api/runs?' + new URLSearchParams({ query: oldestId.toUpperCase(), status: 'failed' }))).json();
  assert.deepEqual(archived.runs.map(item => item.runId), [oldestId]);
  assert.equal(archived.nextCursor, null);
  const archivedSummary = await (await get('/api/run-summary?runId=' + oldestId)).json();
  assert.equal(archivedSummary.run.runId, oldestId);
  const archivedComparison = await (await get('/api/comparison?' + new URLSearchParams({ baseline: oldestId, current: olderCurrentId }))).json();
  assert.equal(archivedComparison.comparison.baseline.runId, oldestId);
  assert.equal(archivedComparison.comparison.current.runId, olderCurrentId);
  assert.match(archivedComparison.markdown, new RegExp(oldestId));
  const firstPage = await (await get('/api/runs?limit=50')).json();
  assert.equal(firstPage.runs.length, 50);
  assert.ok(firstPage.nextCursor);
  const secondPage = await (await get('/api/runs?' + new URLSearchParams({ limit: '50', cursor: firstPage.nextCursor }))).json();
  assert.ok(secondPage.runs.some(item => item.runId === oldestId));
  const listedIds = [...firstPage.runs, ...secondPage.runs].map(item => item.runId);
  assert.equal(new Set(listedIds).size, listedIds.length);
  assert.equal(secondPage.nextCursor, null);
  const evidence = { package: metadata.name, version: metadata.version, source: supplied ? 'npm registry' : 'packed tarball', node: process.version, platform: process.platform, gitRequired: false, commandShim: 'flow-qa', tests: 7, runs: 3, comparison: true, selectiveRun: true, rerunPreparation: 'synthetic failed report to real selected run', fullHistorySearch: true, historyPagination: true, archiveSummary: true, archiveComparison: true, reportExplorer: true, reportAttemptCount: true, reportAttemptTime: true, reportDurationSort: true, reportAttemptSort: true, repeatedAttemptFilter: true, visibleCaseIdDownload: true, reportCopyCaseId: true, clipboardWrites: 'stubbed', filteredReportExportComplete: true, status: report.status, modelCalls: 0, verifiedAt: new Date().toISOString() };
  await writeFile(path.join(artifacts, supplied ? 'registry-smoke.json' : 'tarball-smoke.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 12_000);
    await stopped; clearTimeout(force);
  }
  await rm(temp, { recursive: true, force: true });
}
