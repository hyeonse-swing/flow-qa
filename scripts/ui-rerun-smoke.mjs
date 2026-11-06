import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startDemo } from '../examples/demo/server.ts';
import { startUIServer } from '../src/ui/server.ts';
import { suiteSchema } from '../src/schema.ts';
import { initWorkspace, sha256, writeJSON } from '../src/workspace.ts';

const workspace = await mkdtemp(path.join(tmpdir(), 'flowqa-rerun-'));
const artifacts = path.resolve('output/playwright/rerun');
await mkdir(artifacts, { recursive: true });
let ui; let demo; let browser;
try {
  await initWorkspace(workspace);
  const flow = '# Rerun example\n\nOpen the task list.\n';
  await writeFile(path.join(workspace, 'flows/rerun.md'), flow);
  const statuses = ['passed', 'failed', 'error', 'flaky', 'blocked', 'skipped'];
  const suite = suiteSchema.parse({
    schemaVersion: 'flow-qa/suite-1', id: 'rerun-example', title: 'Failed case preparation',
    source: { file: 'flows/rerun.md', sha256: sha256(flow) },
    requirements: [{ id: 'REQ-1', text: 'The task list opens.' }],
    cases: statuses.map((status, index) => ({ id: `CASE-${index + 1}`, title: `${status} 케이스`, requirementIds: ['REQ-1'], steps: [
      { type: 'open', path: status === 'passed' ? '/excluded-rerun-sentinel' : '/' },
      { type: 'assertVisible', locator: { by: 'text', value: 'Simple task list' } },
    ] })),
  });
  const suiteFile = path.join(workspace, 'cases/rerun.json');
  await writeJSON(suiteFile, suite);
  const suiteBytes = await readFile(suiteFile, 'utf8');
  demo = await startDemo(0);
  let excludedRequests = 0;
  demo.server.on('request', req => { if (req.url === '/excluded-rerun-sentinel') excludedRequests++; });
  const settings = { schemaVersion: 'flow-qa/config-1', targets: { demo: { url: demo.url } }, timeoutMs: 15_000, retries: 0 };
  await writeJSON(path.join(workspace, 'flowqa.config.json'), settings);
  ui = await startUIServer({ workspace, port: 0 });
  const report = {
    schemaVersion: 'flow-qa/report-1', runId: randomUUID(), suiteId: suite.id,
    suiteHash: sha256(`${JSON.stringify(suite, null, 2)}\n`), target: { name: 'demo', url: demo.url },
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: 'failed', errors: [],
    cases: suite.cases.map((item, index) => ({ id: item.id, title: item.title, status: statuses[index], expected: [], attempts: [] })),
  };
  const saveReport = async value => {
    const dir = path.join(workspace, '.flowqa/runs', value.runId);
    await writeJSON(path.join(dir, 'qa-report.json'), value);
    await writeFile(path.join(dir, 'qa-report.md'), '# Synthetic report for UI verification\n');
  };
  await saveReport(report);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; const runRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/api/run')) runRequests.push(req.postDataJSON()); });
  await page.goto(ui.url);
  await page.waitForFunction(() => document.querySelector('#connection-label').textContent.includes('connected'));
  const selected = () => page.locator('#case-selection-list input:checked').evaluateAll(inputs => inputs.map(input => input.dataset.caseId));
  const openReport = async (runId = report.runId) => {
    await page.locator('[data-view="history"]').click();
    await page.locator('#history-list .list-row').filter({ hasText: runId }).locator('[data-action="view-report"]').click();
    await page.waitForFunction(id => document.querySelector('#report-heading').textContent.includes(id), runId);
  };
  const prepare = async () => {
    const response = page.waitForResponse(value => value.url().includes('/api/rerun?'));
    await page.locator('#report-rerun').click();
    const result = await response;
    await page.waitForFunction(() => !document.querySelector('#flow-input').disabled);
    return result;
  };
  await page.locator('#flow-input').fill('Unsaved scenario must survive cancellation');
  await openReport();
  page.once('dialog', dialog => dialog.dismiss());
  await prepare();
  assert.equal(await page.locator('#flow-input').inputValue(), 'Unsaved scenario must survive cancellation');
  assert.equal(await page.locator('#view-history').isVisible(), true);
  page.once('dialog', dialog => dialog.accept());
  assert.equal((await prepare()).status(), 200);
  await page.waitForFunction(() => !document.querySelector('#view-scenario').hidden);
  assert.deepEqual(await selected(), ['CASE-2', 'CASE-3']);
  assert.equal(await page.locator('#flow-input').inputValue(), flow);
  assert.equal(await page.locator('#target-select').inputValue(), 'demo');
  assert.equal(await page.locator('#review-checkbox').isChecked(), false);
  assert.equal(await page.locator('#run-btn').isEnabled(), false);
  assert.match(await page.locator('#notice').textContent(), new RegExp(report.runId));
  assert.equal(runRequests.length, 0, 'Preparation is read-only.');
  const loadedDraft = await page.locator('#suite-editor').inputValue();
  await page.locator('#language-select').selectOption('ko');
  await page.locator('[data-view="history"]').click();
  await page.locator('[data-view="scenario"]').click();
  const refreshed = page.waitForResponse(value => value.url().endsWith('/api/state'));
  await page.locator('#reconnect-btn').click(); await refreshed;
  assert.deepEqual(await selected(), ['CASE-2', 'CASE-3']);
  assert.match(await page.locator('#notice').textContent(), /검토/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('.execution-section').screenshot({ path: path.join(artifacts, 'prepared-ko-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });

  // A changed suite fails without replacing the loaded draft or selection.
  await writeJSON(suiteFile, { ...suite, title: 'Changed after the original run' });
  await openReport();
  assert.equal((await prepare()).status(), 409);
  assert.equal(await page.locator('#suite-editor').inputValue(), loadedDraft);
  assert.deepEqual(await selected(), ['CASE-2', 'CASE-3']);
  assert.equal(await page.locator('#view-history').isVisible(), true);
  await writeFile(suiteFile, suiteBytes);

  // Navigating away while preparation is pending must not replace the draft
  // or pull the user back into Scenario when the late response arrives.
  let releaseResponse;
  let markIntercepted;
  const held = new Promise(resolve => { releaseResponse = resolve; });
  const intercepted = new Promise(resolve => { markIntercepted = resolve; });
  await page.route('**/api/rerun?*', async route => {
    const response = await route.fetch();
    markIntercepted();
    await held;
    await route.fulfill({ response });
  });
  await page.locator('#report-rerun').click();
  await intercepted;
  await page.locator('[data-view="settings"]').click();
  const lateResponse = page.waitForResponse(value => value.url().includes('/api/rerun?'));
  releaseResponse(); await lateResponse;
  await page.waitForFunction(() => !document.querySelector('#flow-input').disabled);
  assert.equal(await page.locator('#view-settings').isVisible(), true);
  assert.equal(await page.locator('#suite-editor').inputValue(), loadedDraft);
  assert.deepEqual(await selected(), ['CASE-2', 'CASE-3']);
  await page.unroute('**/api/rerun?*');
  await page.locator('[data-view="history"]').click();

  // A changed target must be chosen explicitly, even if its name is unchanged.
  await writeJSON(path.join(workspace, 'flowqa.config.json'), { ...settings, targets: { demo: { url: 'http://127.0.0.1:1' } } });
  assert.equal((await prepare()).status(), 200);
  assert.equal(await page.locator('#target-select').inputValue(), '');
  await page.locator('#review-checkbox').check();
  assert.equal(await page.locator('#run-btn').isEnabled(), false);
  assert.match(await page.locator('#notice').textContent(), /대상/);
  assert.equal(runRequests.length, 0);
  await writeJSON(path.join(workspace, 'flowqa.config.json'), settings);
  await openReport();
  await prepare();
  assert.equal(await page.locator('#review-checkbox').isChecked(), false);
  await page.locator('#review-checkbox').check();
  const accepted = page.waitForResponse(value => value.url().endsWith('/api/run') && value.request().method() === 'POST');
  await page.locator('#run-btn').click();
  assert.equal((await accepted).status(), 202);
  assert.deepEqual(runRequests[0].caseIds, ['CASE-2', 'CASE-3']);
  const deadline = Date.now() + 90_000;
  let state;
  do { await new Promise(resolve => setTimeout(resolve, 200)); state = await (await fetch(ui.url + '/api/state')).json(); } while (state.active && Date.now() < deadline);
  assert.equal(state.active, null);
  assert.ok(state.lastRunId && state.lastRunId !== report.runId, state.lastError);
  const rerun = (await (await fetch(`${ui.url}/api/report?runId=${state.lastRunId}`)).json()).report;
  assert.equal(rerun.status, 'passed', JSON.stringify(rerun.errors));
  assert.deepEqual(rerun.selection, { caseIds: ['CASE-2', 'CASE-3'], totalCases: 6 });
  assert.equal(excludedRequests, 0);
  assert.equal(await readFile(suiteFile, 'utf8'), suiteBytes);
  await page.locator('[data-view="history"]').click();
  await page.waitForFunction(id => document.querySelector('#history-list').textContent.includes(id), rerun.runId);
  await openReport(rerun.runId);
  assert.equal(await page.locator('#report-rerun').isEnabled(), false, 'A passing report has nothing to prepare.');
  await page.locator('#language-select').selectOption('en');
  await openReport();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('#report-panel').screenshot({ path: path.join(artifacts, 'report-en-mobile.png') });
  assert.deepEqual(errors, []);
  const result = { fixtureStatuses: 6, selected: ['failed', 'error'], realBrowserCases: 2, excludedRequests, preparationNeverRuns: true, unsavedCancel: true, changedSuitePreservedDraft: true, changedTargetCleared: true, lateResponseIgnored: true, freshReview: true, bilingual: true, mobileOverflow: false, modelCalls: 0 };
  await writeFile(path.join(artifacts, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (browser) await browser.close();
  if (ui) await ui.close();
  if (demo) await demo.close();
  await rm(workspace, { recursive: true, force: true });
}
