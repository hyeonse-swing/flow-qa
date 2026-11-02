import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startUIServer } from '../src/ui/server.ts';
import { initWorkspace, writeJSON } from '../src/workspace.ts';

const workspace = await mkdtemp(path.join(tmpdir(), 'flowqa-comparison-'));
const artifacts = path.resolve('output/playwright/comparison');
await mkdir(artifacts, { recursive: true });
let ui; let browser;
try {
  await initWorkspace(workspace);
  ui = await startUIServer({ workspace, port: 0 });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const makeCase = (id, status) => ({ id, title: id === 'A' ? '<img src=x onerror=alert(1)> 케이스' : `Case ${id}`, status, expected: ['Expected outcome'], attempts: [] });
  const baseline = {
    schemaVersion: 'flow-qa/report-1', runId: randomUUID(), suiteId: 'comparison-demo', suiteHash: 'a'.repeat(64),
    target: { name: '로컬 QA', url: 'http://127.0.0.1:3000' }, startedAt: '2026-11-01T00:00:00.000Z', finishedAt: '2026-11-01T00:01:00.000Z', status: 'failed', errors: [],
    cases: [['A', 'passed'], ['B', 'failed'], ['C', 'passed'], ['D', 'blocked'], ['E', 'failed'], ['F', 'error'], ['G', 'skipped'], ['H', 'passed']].map(([id, status]) => makeCase(id, status)),
  };
  const current = { ...baseline, runId: randomUUID(), startedAt: '2026-11-02T00:00:00.000Z', finishedAt: '2026-11-02T00:01:00.000Z', cases: [['A', 'failed'], ['B', 'passed'], ['C', 'flaky'], ['D', 'passed'], ['E', 'failed'], ['F', 'blocked'], ['G', 'skipped'], ['I', 'passed']].map(([id, status]) => makeCase(id, status)) };
  const saveReport = async report => {
    const dir = path.join(workspace, '.flowqa/runs', report.runId);
    await writeJSON(path.join(dir, 'qa-report.json'), report);
    await writeFile(path.join(dir, 'qa-report.md'), `# QA results: ${report.suiteId}\n`);
  };
  await page.goto(ui.url);
  await page.waitForFunction(() => document.querySelector('#connection-label').textContent.includes('connected'));
  await page.locator('#flow-input').fill('Keep this draft while comparing reports');
  const draftBefore = await page.locator('#suite-editor').inputValue();
  await page.locator('[data-view="history"]').click();
  assert.equal(await page.locator('#compare-btn').isEnabled(), false, 'No runs cannot be compared.');
  await saveReport(baseline);
  await page.waitForFunction(id => [...document.querySelector('#compare-baseline').options].some(option => option.value === id), baseline.runId);
  await page.locator('#compare-baseline').selectOption(baseline.runId);
  assert.equal(await page.locator('#compare-btn').isEnabled(), false, 'A baseline alone cannot be compared.');
  await saveReport(current);
  await page.waitForFunction(id => [...document.querySelector('#compare-current').options].some(option => option.value === id), current.runId);
  const selectPair = async (a = baseline.runId, b = current.runId) => {
    await page.locator('#compare-baseline').selectOption(a);
    await page.locator('#compare-current').selectOption(b);
  };
  await selectPair(baseline.runId, baseline.runId);
  assert.equal(await page.locator('#compare-btn').isEnabled(), false, 'The same run cannot be compared to itself.');
  await selectPair();
  const compare = async () => {
    const response = page.waitForResponse(result => result.url().includes('/api/comparison?'));
    await page.locator('#compare-btn').click();
    const result = await response;
    if (result.ok()) await page.waitForFunction(() => !document.querySelector('#comparison-json').disabled);
    return result;
  };
  assert.equal((await compare()).status(), 200);
  assert.equal(await page.locator('.comparison-case').count(), 9);
  const expectedCounts = { 'newly-failed': 1, 'now-passed': 1, changed: 3, unchanged: 2, added: 1, missing: 1 };
  for (const [category, count] of Object.entries(expectedCounts)) assert.equal(await page.locator(`.comparison-case[data-category="${category}"]`).count(), count, category);
  assert.equal(await page.locator('#comparison-content img').count(), 0, 'Case titles render as text.');
  const download = async id => {
    const pending = page.waitForEvent('download');
    await page.locator(id).click();
    const result = await pending;
    return { name: result.suggestedFilename(), text: await readFile(await result.path(), 'utf8') };
  };
  const initial = JSON.parse((await download('#comparison-json')).text);
  assert.equal(initial.schemaVersion, 'flow-qa/comparison-1');
  assert.deepEqual(initial.counts, expectedCounts);
  assert.equal(initial.baseline.runId, baseline.runId);
  assert.equal(initial.current.runId, current.runId);
  await page.locator('#comparison-filter').selectOption('newly-failed');
  assert.equal(await page.locator('.comparison-case').count(), 1);
  assert.equal(JSON.parse((await download('#comparison-json')).text).cases.length, 9, 'Export includes all categories despite display filter.');
  const english = (await download('#comparison-md')).text;
  assert.ok(english.includes(baseline.runId) && english.includes(current.runId));
  await page.locator('#language-select').selectOption('ko');
  assert.equal(await page.locator('#comparison-filter').inputValue(), 'newly-failed');
  assert.equal(await page.locator('.comparison-case').count(), 1);
  const korean = (await download('#comparison-md')).text;
  assert.notEqual(korean, english, 'Markdown follows the current UI language.');
  assert.match(korean, /비교/);
  await page.locator('#compare-open-current').click();
  await page.locator('#report-content .case-report').first().waitFor();
  const reportHeading = await page.locator('#report-heading').textContent();
  await page.locator('#history-search').fill('no-search-results');
  await page.locator('#history-status-filter').selectOption('passed');
  assert.equal(await page.locator('#history-list .list-row').count(), 0);
  assert.equal(await page.locator('#compare-current').inputValue(), current.runId);
  assert.equal(await page.locator('.comparison-case').count(), 1);
  await page.locator('[data-view="scenario"]').click();
  assert.equal(await page.locator('#flow-input').inputValue(), 'Keep this draft while comparing reports');
  assert.equal(await page.locator('#suite-editor').inputValue(), draftBefore);
  assert.equal(await page.locator('#review-checkbox').isChecked(), false);
  await page.locator('[data-view="history"]').click();
  assert.equal(await page.locator('#compare-baseline').inputValue(), baseline.runId);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Comparison fits 390px including IDs and hostile titles.');
  await page.screenshot({ path: path.join(artifacts, 'comparison-ko-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const changed = { ...current, runId: randomUUID(), suiteHash: 'b'.repeat(64), status: 'interrupted' };
  const otherTarget = { ...current, runId: randomUUID(), target: { name: baseline.target.name, url: 'http://127.0.0.1:4000' } };
  await saveReport(changed); await saveReport(otherTarget);
  await page.waitForFunction(id => [...document.querySelector('#compare-current').options].some(option => option.value === id), otherTarget.runId);
  assert.equal(await page.locator('#compare-current').inputValue(), current.runId, 'Polling preserves both choices.');
  assert.equal(await page.locator('.comparison-case').count(), 1, 'Polling preserves displayed comparison.');
  await selectPair(baseline.runId, changed.runId);
  assert.equal(await page.locator('#comparison-json').isEnabled(), false, 'Changing selection invalidates old download.');
  assert.equal((await compare()).status(), 200);
  const changedExport = JSON.parse((await download('#comparison-json')).text);
  assert.ok(changedExport.warnings.includes('suite-changed') && changedExport.warnings.includes('incomplete-run'));
  assert.ok((await page.locator('#comparison-warnings').textContent()).trim());
  await page.locator('#compare-swap').click();
  assert.equal(await page.locator('#compare-baseline').inputValue(), changed.runId);
  assert.equal(await page.locator('#comparison-json').isEnabled(), false);
  await compare();
  assert.ok(JSON.parse((await download('#comparison-json')).text).warnings.includes('reverse-order'));
  await selectPair(baseline.runId, otherTarget.runId);
  assert.equal((await compare()).status(), 409);
  await page.waitForFunction(() => document.querySelector('#comparison-status').textContent.trim().length > 0);
  assert.equal(await page.locator('#comparison-json').isEnabled(), false);
  assert.equal(await page.locator('#report-heading').textContent(), reportHeading, 'Comparison errors preserve the open report.');

  // Delay a real API response and change the pair while it is in flight.
  for (const staleFailure of [false, true]) {
    let release; let intercepted;
    const arrived = new Promise(resolve => { intercepted = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const route = async interceptedRoute => {
      const response = await interceptedRoute.fetch();
      intercepted(); await gate;
      if (staleFailure) await interceptedRoute.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'STALE_COMPARISON_ERROR' }) });
      else await interceptedRoute.fulfill({ response });
    };
    await page.route('**/api/comparison?**', route, { times: 1 });
    await selectPair();
    await page.locator('#compare-btn').click();
    await arrived;
    await selectPair(baseline.runId, changed.runId);
    assert.equal(await page.locator('#compare-btn').isEnabled(), true, 'A new pair can be requested while an old request waits.');
    await compare();
    release();
    await page.waitForLoadState('networkidle');
    await page.unroute('**/api/comparison?**', route);
    assert.equal(JSON.parse((await download('#comparison-json')).text).current.runId, changed.runId, 'Late responses cannot restore stale results.');
    assert.doesNotMatch(await page.locator('#comparison-status').textContent(), /STALE_COMPARISON_ERROR/);
  }
  // Language changes invalidate a pending request, including a switch back.
  let releaseLocale; let localeArrived;
  const localeSeen = new Promise(resolve => { localeArrived = resolve; });
  const localeGate = new Promise(resolve => { releaseLocale = resolve; });
  const localeRoute = async route => { const response = await route.fetch(); localeArrived(); await localeGate; await route.fulfill({ response }); };
  await page.route('**/api/comparison?**', localeRoute, { times: 1 });
  await page.locator('#compare-btn').click();
  await localeSeen;
  await page.locator('#language-select').selectOption('en');
  await page.locator('#language-select').selectOption('ko');
  assert.equal(await page.locator('#compare-btn').isEnabled(), true);
  releaseLocale();
  await page.waitForLoadState('networkidle');
  await page.unroute('**/api/comparison?**', localeRoute);
  assert.equal(await page.locator('#comparison-json').isEnabled(), false, 'A response from before the language switch stays stale.');
  await compare();

  for (const change of ['selection', 'language']) {
    let releaseDownload; let downloadArrived;
    const seen = new Promise(resolve => { downloadArrived = resolve; });
    const gate = new Promise(resolve => { releaseDownload = resolve; });
    const route = async route => { const response = await route.fetch(); downloadArrived(); await gate; await route.fulfill({ response }); };
    const downloads = [];
    const track = download => downloads.push(download.suggestedFilename());
    page.on('download', track);
    await page.route('**/api/comparison?**', route, { times: 1 });
    await page.locator('#comparison-md').click();
    await seen;
    if (change === 'selection') await selectPair();
    else await page.locator('#language-select').selectOption('en');
    releaseDownload();
    await page.waitForLoadState('networkidle');
    await page.unroute('**/api/comparison?**', route);
    page.off('download', track);
    assert.deepEqual(downloads, [], `No stale Markdown download after ${change} changes.`);
    await selectPair(baseline.runId, changed.runId);
    await compare();
  }
  await page.locator('#language-select').selectOption('en');
  await page.locator('#comparison-filter').selectOption('');
  await page.screenshot({ path: path.join(artifacts, 'comparison-en.png'), fullPage: true });
  const mobileBaseline = { ...baseline, runId: randomUUID(), target: { name: 'QA Phone', kind: 'mobile', platform: 'ios', bundleId: 'com.example.app', device: 'QA iPhone' } };
  const mobileCurrent = { ...current, runId: randomUUID(), target: { ...mobileBaseline.target } };
  await saveReport(mobileBaseline); await saveReport(mobileCurrent);
  await page.waitForFunction(id => [...document.querySelector('#compare-current').options].some(option => option.value === id), mobileCurrent.runId);
  await selectPair(mobileBaseline.runId, mobileCurrent.runId);
  await compare();
  assert.ok(JSON.parse((await download('#comparison-json')).text).warnings.includes('mobile-identity-unverified'));
  assert.match(await page.locator('#comparison-warnings').textContent(), /physical device/);
  await page.locator('#language-select').selectOption('ko');
  assert.match(await page.locator('#comparison-warnings').textContent(), /실제 기기/);
  await selectPair(baseline.runId, changed.runId);
  await compare();
  await rm(path.join(workspace, '.flowqa/runs', changed.runId), { recursive: true, force: true });
  await page.waitForFunction(() => document.querySelector('#compare-current').value === '');
  assert.equal(await page.locator('#comparison-json').isEnabled(), false, 'Disappearing selection invalidates comparison.');
  assert.deepEqual(errors, []);
  const result = { runComparison: true, categoryCounts: expectedCounts, localizedDownloads: true, staleResponsesIgnored: true, staleDownloadsIgnored: true, languageRace: true, pollingPreservesSelection: true, mobileIdentityWarning: true, mobileOverflow: false, fixtures: true, modelCalls: 0 };
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (browser) await browser.close();
  if (ui) await ui.close();
  await rm(workspace, { recursive: true, force: true });
}
