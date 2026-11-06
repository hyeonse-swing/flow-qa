import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startUIServer } from '../src/ui/server.ts';
import { initWorkspace, readSuite, sha256, writeJSON } from '../src/workspace.ts';

const workspace = await mkdtemp(path.join(tmpdir(), 'flowqa-history-'));
const artifacts = path.resolve('output/playwright/history');
await mkdir(artifacts, { recursive: true });
let ui; let browser;
try {
  await initWorkspace(workspace);
  const suite = await readSuite(path.join(workspace, 'cases/task-flow.json'));
  ui = await startUIServer({ workspace, port: 0 });
  const statuses = ['passed', 'failed', 'blocked', 'error', 'interrupted'];
  const fixtures = [];
  const saveReport = async (index, at = new Date(Date.UTC(2026, 0, 1, 0, 0, index))) => {
    const runId = randomUUID();
    const value = {
      schemaVersion: 'flow-qa/report-1', runId, suiteId: index === 0 ? suite.id : `history-suite-${index}`,
      suiteHash: sha256(`${JSON.stringify(suite, null, 2)}\n`),
      target: { name: index === 1 ? '오래된-대상' : 'demo', url: 'http://127.0.0.1:4178' },
      startedAt: at.toISOString(), finishedAt: at.toISOString(), status: index < 2 ? 'failed' : statuses[index % statuses.length], errors: [],
      cases: index === 0 ? suite.cases.map((item, i) => ({ id: item.id, title: item.title, status: i === 1 ? 'failed' : 'passed', expected: [], attempts: [] })) : [],
    };
    const dir = path.join(workspace, '.flowqa/runs', runId);
    await writeJSON(path.join(dir, 'qa-report.json'), value);
    await writeFile(path.join(dir, 'qa-report.md'), `# History fixture ${index}\n`);
    await utimes(dir, at, at);
    return value;
  };
  for (let index = 0; index < 70; index++) fixtures.push(await saveReport(index));
  const oldest = fixtures[0];
  const initialState = await (await fetch(ui.url + '/api/state')).json();
  assert.equal(initialState.runs.length, 50);
  assert.equal(initialState.runs.some(item => item.runId === oldest.runId), false);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; let runRequests = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/run')) runRequests++; });
  await page.goto(ui.url);
  await page.waitForFunction(() => document.querySelector('#connection-label').textContent.includes('connected'));
  await page.locator('#flow-input').fill('Keep this unsaved flow while browsing old reports');
  const idle = () => page.waitForFunction(() => document.querySelector('#history-list').getAttribute('aria-busy') === 'false');
  const rows = () => page.locator('#history-list .list-row');
  const search = async query => { await page.locator('#history-search').fill(query); await idle(); };
  const filter = async status => { await page.locator('#history-status-filter').selectOption(status); await idle(); };
  await page.locator('[data-view="history"]').click(); await idle();
  assert.equal(await rows().count(), 50);
  assert.equal(await page.locator('#history-load-more').isEnabled(), true);
  const firstRows = await rows().allTextContents();

  // Failed append retains both the current rows and the cursor for retry.
  const failPage = async route => {
    if (new URL(route.request().url()).searchParams.has('cursor')) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary history test failure' }) });
    else await route.continue();
  };
  await page.route('**/api/runs?*', failPage);
  await page.locator('#history-load-more').click(); await idle();
  assert.deepEqual(await rows().allTextContents(), firstRows);
  assert.match(await page.locator('#history-page-status').textContent(), /failure|failed|error|retry/i);
  await page.unroute('**/api/runs?*', failPage);
  await page.locator('#history-load-more').click(); await idle();
  assert.equal(await rows().count(), 70);
  assert.equal(new Set(await rows().allTextContents()).size, 70);
  assert.match(await page.locator('#history-page-status').textContent(), /70/);
  await page.locator('#language-select').selectOption('ko');
  await page.locator('[data-view="scenario"]').click();
  assert.equal(await page.locator('#flow-input').inputValue(), 'Keep this unsaved flow while browsing old reports');
  await page.locator('[data-view="history"]').click(); await idle();
  assert.equal(await rows().count(), 70, 'Navigation and language retain loaded pages.');
  const newest = await saveReport(70, new Date());
  await page.waitForFunction(() => /새|변경|갱신/.test(document.querySelector('#history-page-status').textContent));
  assert.equal(await rows().count(), 70, 'Polling must not collapse multiple loaded pages.');
  await page.locator('#history-refresh').click(); await idle();
  assert.equal(await rows().count(), 50);
  assert.ok((await rows().first().textContent()).includes(newest.runId));
  await page.locator('#history-load-more').click(); await idle();
  assert.equal(await rows().count(), 71);
  assert.equal(new Set(await rows().allTextContents()).size, 71);
  await search(`  ${oldest.runId.toUpperCase()}  `);
  assert.equal(await rows().count(), 1, 'Search reaches a report older than the recent 50.');
  assert.ok((await rows().textContent()).includes(oldest.runId));
  await search('오래된-대상');
  assert.equal(await rows().count(), 1);
  await filter('passed');
  assert.equal(await rows().count(), 0);
  await filter('failed');
  assert.equal(await rows().count(), 1);
  await search(suite.id.toUpperCase());
  assert.equal(await rows().count(), 1, 'Suite ID search spans the full stored history.');

  // A slow response from a superseded query cannot replace the latest results.
  let release; let markIntercepted;
  const held = new Promise(resolve => { release = resolve; });
  const intercepted = new Promise(resolve => { markIntercepted = resolve; });
  const slowQuery = async route => {
    if (new URL(route.request().url()).searchParams.get('query') === 'slow-history-query') {
      const response = await route.fetch(); markIntercepted(); await held; await route.fulfill({ response });
    } else await route.continue();
  };
  await page.route('**/api/runs?*', slowQuery);
  await page.locator('#history-search').fill('slow-history-query'); await intercepted;
  await search(oldest.runId);
  assert.equal(await rows().count(), 1);
  const late = page.waitForResponse(response => response.url().includes('slow-history-query'));
  release(); await late; await idle();
  assert.ok((await rows().textContent()).includes(oldest.runId));
  await page.unroute('**/api/runs?*', slowQuery);
  await rows().getByRole('button').click();
  await page.waitForFunction(id => document.querySelector('#report-heading').textContent.includes(id), oldest.runId);
  const downloaded = page.waitForEvent('download'); await page.locator('#report-json').click();
  assert.equal(JSON.parse(await readFile(await (await downloaded).path(), 'utf8')).runId, oldest.runId);
  await search('no-such-history');
  assert.equal(await rows().count(), 0);
  assert.ok((await page.locator('#report-heading').textContent()).includes(oldest.runId), 'Search preserves the open report.');
  await search(oldest.runId);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(artifacts, 'older-history-ko-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#report-rerun').click();
  await page.waitForFunction(() => !document.querySelector('#view-scenario').hidden && !document.querySelector('#flow-input').disabled);
  assert.deepEqual(await page.locator('#case-selection-list input:checked').evaluateAll(nodes => nodes.map(node => node.dataset.caseId)), [suite.cases[1].id]);
  assert.equal(await page.locator('#review-checkbox').isChecked(), false);
  assert.equal(runRequests, 0, 'Old-report preparation never starts a run.');
  await page.locator('[data-view="history"]').click(); await idle();
  await rm(path.join(workspace, '.flowqa/runs', oldest.runId), { recursive: true });
  await page.locator('#history-refresh').click(); await idle();
  assert.equal(await rows().count(), 0, 'Explicit refresh removes an externally deleted older report.');
  assert.equal(await page.locator('#history-search').inputValue(), oldest.runId);
  await page.locator('#language-select').selectOption('en');
  await search(''); await filter('');
  assert.equal(await rows().count(), 50);

  // A recent-record update while the first page is still in flight must get
  // one follow-up refresh, rather than being lost behind that old response.
  let releaseFirst; let markFirst;
  const firstHeld = new Promise(resolve => { releaseFirst = resolve; });
  const firstIntercepted = new Promise(resolve => { markFirst = resolve; });
  let holdFirst = true;
  const holdPage = async route => {
    if (holdFirst) {
      holdFirst = false;
      const response = await route.fetch(); markFirst(); await firstHeld; await route.fulfill({ response });
    } else await route.continue();
  };
  await page.route('**/api/runs?*', holdPage);
  await page.locator('#history-refresh').click(); await firstIntercepted;
  const concurrent = await saveReport(71, new Date());
  await page.waitForResponse(async response => response.url().endsWith('/api/state') &&
    (await response.json()).runs?.some(item => item.runId === concurrent.runId));
  releaseFirst();
  await page.waitForFunction(id => document.querySelector('#history-list .list-row')?.textContent.includes(id), concurrent.runId);
  await idle();
  assert.equal(await rows().count(), 50);
  await page.unroute('**/api/runs?*', holdPage);
  await page.screenshot({ path: path.join(artifacts, 'history-en.png'), fullPage: true });
  assert.deepEqual(errors, []);
  const result = { fixtureReports: 72, pageSize: 50, fullHistorySearch: true, statusAndQuery: true, appendRetry: true, pagesPreserved: true, refreshUpdates: true, inFlightUpdateRetained: true, noDuplicates: true, lateResponseIgnored: true, olderReportDownload: true, olderReportPreparation: true, draftPreserved: true, bilingual: true, mobileOverflow: false, modelCalls: 0 };
  await writeFile(path.join(artifacts, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (browser) await browser.close();
  if (ui) await ui.close();
  await rm(workspace, { recursive: true, force: true });
}
