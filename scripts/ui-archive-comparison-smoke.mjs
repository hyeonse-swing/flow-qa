import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startUIServer } from '../src/ui/server.ts';
import { initWorkspace, writeJSON } from '../src/workspace.ts';

const workspace = await mkdtemp(path.join(tmpdir(), 'flowqa-archive-comparison-'));
const artifacts = path.resolve('output/playwright/archive-comparison');
await mkdir(artifacts, { recursive: true });
let ui; let browser;
try {
  await initWorkspace(workspace);
  const fixtures = [];
  const save = async index => {
    const runId = randomUUID();
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
    const status = index % 2 ? 'failed' : 'passed';
    const report = { schemaVersion: 'flow-qa/report-1', runId, suiteId: 'archive-comparison', suiteHash: 'a'.repeat(64),
      target: { name: '오래된 실행', url: 'http://127.0.0.1:4178' }, startedAt: at.toISOString(), finishedAt: at.toISOString(), status, errors: [],
      cases: [{ id: 'A', title: 'Archive case', status, expected: [], attempts: [] }] };
    const dir = path.join(workspace, '.flowqa/runs', runId);
    await writeJSON(path.join(dir, 'qa-report.json'), report);
    if (index !== 0) await writeFile(path.join(dir, 'qa-report.md'), '# Archive fixture\n');
    await utimes(dir, at, at);
    return report;
  };
  for (let index = 0; index < 60; index++) fixtures.push(await save(index));
  const [baseline, current, replacement] = fixtures;
  ui = await startUIServer({ workspace, port: 0 });
  const state = await (await fetch(ui.url + '/api/state')).json();
  for (const run of [baseline, current, replacement]) assert.equal(state.runs.some(item => item.runId === run.runId), false);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; let runRequests = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/run')) runRequests++; });
  await page.goto(ui.url);
  await page.waitForFunction(() => document.querySelector('#connection-label').textContent.includes('connected'));
  await page.locator('#flow-input').fill('Preserve this draft while selecting archived comparisons');
  const editorBefore = await page.locator('#suite-editor').inputValue();
  const reviewBefore = await page.locator('#review-checkbox').isChecked();
  const idle = () => page.waitForFunction(() => document.querySelector('#history-list').getAttribute('aria-busy') === 'false');
  const search = async query => { await page.locator('#history-search').fill(query); await idle(); };
  const row = run => page.locator(`#history-list .list-row[data-run-id="${run.runId}"]`);
  const choose = async (run, role) => {
    await search(run.runId);
    await row(run).locator(`[data-action="compare-${role}"]`).click();
    assert.equal(await page.locator(`#compare-${role}`).inputValue(), run.runId);
    assert.equal(await row(run).locator(`[data-action="compare-${role}"]`).getAttribute('aria-pressed'), 'true');
  };
  const pair = async (a = baseline, b = current) => {
    assert.equal(await page.locator('#compare-baseline').inputValue(), a.runId);
    assert.equal(await page.locator('#compare-current').inputValue(), b.runId);
  };
  const compare = async () => {
    await page.locator('#compare-btn').click();
    await page.waitForFunction(() => !document.querySelector('#comparison-json').disabled);
  };
  const download = async id => {
    const pending = page.waitForEvent('download'); await page.locator(id).click();
    return readFile(await (await pending).path(), 'utf8');
  };
  await page.locator('[data-view="history"]').click(); await idle();
  await row(fixtures[59]).locator('[data-action="view-report"]').click();
  await page.waitForFunction(id => document.querySelector('#report-heading').textContent.includes(id), fixtures[59].runId);
  await choose(baseline, 'baseline');
  await choose(current, 'current');
  await compare();
  const result = JSON.parse(await download('#comparison-json'));
  assert.equal(result.baseline.runId, baseline.runId);
  assert.equal(result.current.runId, current.runId);
  assert.equal(result.counts['newly-failed'], 1);
  assert.match(await download('#comparison-md'), new RegExp(baseline.runId));
  await search('no-archive-match'); await pair();
  await page.locator('#history-status-filter').selectOption('passed'); await idle(); await pair();
  await page.locator('#history-refresh').click(); await idle(); await pair();
  const validated = page.waitForResponse(response => response.url().includes('/api/run-summary?') && response.url().includes(baseline.runId));
  await validated; await pair();
  assert.equal(await page.locator('#comparison-json').isEnabled(), true);
  await page.locator('#language-select').selectOption('ko'); await pair();
  await page.locator('[data-view="scenario"]').click();
  assert.equal(await page.locator('#flow-input').inputValue(), 'Preserve this draft while selecting archived comparisons');
  assert.equal(await page.locator('#suite-editor').inputValue(), editorBefore);
  assert.equal(await page.locator('#review-checkbox').isChecked(), reviewBefore);
  await page.locator('[data-view="history"]').click(); await idle(); await pair();
  assert.ok((await page.locator('#report-heading').textContent()).includes(fixtures[59].runId));
  await page.locator('#history-status-filter').selectOption(''); await idle();
  await search('');
  await page.locator('#history-load-more').click(); await idle(); await pair();
  assert.equal(await page.locator('#history-list .list-row').count(), 60);
  await page.locator('#compare-swap').click(); await pair(current, baseline);
  assert.equal(await page.locator('#comparison-json').isEnabled(), false);
  await page.locator('#compare-swap').click(); await pair();
  await compare();
  fixtures.push(await save(60));
  await page.waitForResponse(async response => response.url().endsWith('/api/state') && (await response.json()).runs?.some(item => item.runId === fixtures[60].runId));
  await pair();
  await search(baseline.runId);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(artifacts, 'archive-comparison-ko-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  // A temporary validation outage does not erase an archived pair or its result.
  const unavailable = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary fixture outage' }) });
  await page.route('**/api/run-summary?*', unavailable);
  await page.waitForResponse(response => response.url().includes('/api/run-summary?') && response.status() === 503);
  await pair();
  assert.equal(await page.locator('#comparison-json').isEnabled(), true);
  await page.unroute('**/api/run-summary?*', unavailable);

  // A stale missing-file response must not clear a newly selected archived run.
  let release; let mark;
  const held = new Promise(resolve => { release = resolve; });
  const intercepted = new Promise(resolve => { mark = resolve; });
  let once = true;
  const delayedMissing = async route => {
    if (once && new URL(route.request().url()).searchParams.get('runId') === baseline.runId) {
      once = false; mark(); await held;
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Stale missing fixture' }) });
    } else await route.continue();
  };
  await page.route('**/api/run-summary?*', delayedMissing); await intercepted;
  await choose(replacement, 'baseline');
  assert.equal(await page.locator('#comparison-json').isEnabled(), false);
  await choose(baseline, 'baseline'); // Same ID again is a newer selection, not the held request's selection.
  await compare();
  const late = page.waitForResponse(response => response.url().includes('/api/run-summary?') && response.status() === 404);
  release(); await late;
  await page.waitForResponse(response => response.url().includes('/api/run-summary?') && response.url().includes(baseline.runId) && response.status() === 200);
  await pair();
  assert.equal(await page.locator('#comparison-json').isEnabled(), true);
  await page.unroute('**/api/run-summary?*', delayedMissing);

  // Deletion is detected even though the latest 50 records do not change.
  await choose(replacement, 'baseline'); await compare();
  await rm(path.join(workspace, '.flowqa/runs', replacement.runId), { recursive: true });
  await page.waitForFunction(() => document.querySelector('#compare-baseline').value === '');
  assert.equal(await page.locator('#compare-current').inputValue(), current.runId);
  assert.equal(await page.locator('#comparison-json').isEnabled(), false);
  assert.equal(await page.locator('#comparison-md').isEnabled(), false);
  assert.equal(await page.locator(`#compare-baseline option[value="${replacement.runId}"]`).count(), 0);
  assert.equal(runRequests, 0, 'Choosing/comparing archived runs never executes QA.');
  await page.locator('#language-select').selectOption('en');
  await search(current.runId);
  await page.screenshot({ path: path.join(artifacts, 'archive-comparison-en.png'), fullPage: true });
  assert.deepEqual(errors, []);
  const evidence = { fixtures: 61, archiveComparison: true, jsonOnlyReport: true, rowSelection: true, selectedRows: true,
    searchFilterPagingPreservesPair: true, pollingPreservesPair: true, swap: true, transientErrorPreservesPair: true,
    staleValidationIgnored: true, archivedDeletionInvalidates: true, draftAndReportPreserved: true,
    bilingual: true, mobileOverflow: false, modelCalls: 0 };
  await writeFile(path.join(artifacts, 'result.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (browser) await browser.close();
  if (ui) await ui.close();
  await rm(workspace, { recursive: true, force: true });
}
