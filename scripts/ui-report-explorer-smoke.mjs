import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startUIServer } from '../src/ui/server.ts';
import { renderMarkdown } from '../src/report.ts';
import { suiteSchema } from '../src/schema.ts';
import { initWorkspace, sha256, writeJSON } from '../src/workspace.ts';

const workspace = await mkdtemp(path.join(tmpdir(), 'flowqa-report-explorer-'));
const artifacts = path.resolve('output/playwright/report-explorer');
await mkdir(artifacts, { recursive: true });
let ui; let browser;
try {
  await initWorkspace(workspace);
  const statuses = ['passed', 'failed', 'error', 'flaky', 'blocked', 'skipped'];
  const flow = '# Report exploration\n\nInspect recorded case outcomes.\n';
  await writeFile(path.join(workspace, 'flows/explorer.md'), flow);
  const suite = suiteSchema.parse({ schemaVersion: 'flow-qa/suite-1', id: 'report-explorer', title: 'Report explorer fixtures',
    source: { file: 'flows/explorer.md', sha256: sha256(flow) }, requirements: [{ id: 'REQ-1', text: 'Inspect the task list.' }],
    cases: statuses.map((status, index) => ({ id: `CASE-${index + 1}`, title: index === 4 ? '한국어 준비 조건' : `Outcome ${index + 1}`,
      requirementIds: ['REQ-1'], steps: [{ type: 'open', path: '/' }, { type: 'assertVisible', locator: { by: 'text', value: 'Simple task list' } }] })) });
  await writeJSON(path.join(workspace, 'cases/explorer.json'), suite);
  await writeJSON(path.join(workspace, 'flowqa.config.json'), { schemaVersion: 'flow-qa/config-1', targets: { demo: { url: 'http://127.0.0.1:4178' } }, timeoutMs: 15_000, retries: 0 });
  const report = { schemaVersion: 'flow-qa/report-1', runId: randomUUID(), suiteId: suite.id,
    suiteHash: sha256(`${JSON.stringify(suite, null, 2)}\n`), target: { name: 'demo', url: 'http://127.0.0.1:4178' },
    startedAt: '2026-11-06T00:00:00Z', finishedAt: '2026-11-06T00:01:00Z', status: 'failed', errors: ['Whole report warning remains visible'],
    cases: suite.cases.map((item, index) => ({ id: item.id, title: item.title, status: statuses[index],
      expected: [`Unique expectation ${index + 1}`], attempts: [], ...(index === 4 ? { reason: 'Seed fixture unavailable' } : {}) })) };
  const attempt = index => ({ index, status: 'failed', startedAt: report.startedAt, durationMs: 40,
    steps: [{ api: 'assertVisible', label: `Attempt step ${index + 1}`, status: 'failed', error: { code: 'STEP_MISMATCH', message: 'Nested token missing' } }],
    error: { code: 'ASSERTION_MISMATCH', message: 'Outer packet missing' },
    secondaryErrors: [{ code: 'TEARDOWN_NOTE', message: 'Secondary teardown detail' }], artifacts: [] });
  report.cases[0].attempts = [{ index: 0, status: 'passed', startedAt: report.startedAt, durationMs: 20, steps: [], secondaryErrors: [], artifacts: [] }];
  report.cases[1].attempts = [attempt(0), { ...attempt(1), artifacts: [
    { kind: 'log', redaction: 'incomplete', path: 'raw/artifacts/hidden-path-sentinel.txt' },
    { kind: 'log', redaction: 'complete', path: 'raw/artifacts/approved.txt' },
  ] }];
  report.cases[2].title = '<img src=x onerror=alert(1)> visible text';
  const saveReport = async (value, markdown = true) => {
    const dir = path.join(workspace, '.flowqa/runs', value.runId);
    await writeJSON(path.join(dir, 'qa-report.json'), value);
    if (markdown) await writeFile(path.join(dir, 'qa-report.md'), renderMarkdown(value));
    return dir;
  };
  const reportDir = await saveReport(report);
  await mkdir(path.join(reportDir, 'raw/artifacts'), { recursive: true });
  await writeFile(path.join(reportDir, 'raw/artifacts/approved.txt'), 'Approved evidence from original attempt 2 / artifact 2');
  const partial = { ...report, runId: randomUUID(), cases: [report.cases[0], report.cases[2]], selection: { caseIds: ['CASE-1', 'CASE-3'], totalCases: 6 } };
  const empty = { ...report, runId: randomUUID(), cases: [], status: 'interrupted' };
  const unreadable = { ...report, runId: randomUUID() };
  await saveReport(partial); await saveReport(empty); await saveReport(unreadable, false);
  const baseAttempt = report.cases[0].attempts[0];
  const { durationMs: omittedDuration, ...missingDuration } = baseAttempt;
  const durationEdgeAttempts = [[], [{ ...baseAttempt, durationMs: 0 }], [baseAttempt, missingDuration],
    [{ ...baseAttempt, durationMs: -1 }], [{ ...baseAttempt, durationMs: '20' }], [{ ...baseAttempt, durationMs: null }],
    [{ ...baseAttempt, durationMs: Number.MAX_VALUE }, { ...baseAttempt, durationMs: Number.MAX_VALUE }],
    [baseAttempt], [baseAttempt], [{ ...baseAttempt, durationMs: 5 }], [{ ...baseAttempt, durationMs: 0 }]];
  const durationEdges = { ...report, runId: randomUUID(), cases: durationEdgeAttempts.map((attempts, index) => ({
    id: `DURATION-${index}`, title: 'Duration fixture', status: 'passed', expected: [], attempts,
  })) };
  await saveReport(durationEdges);
  ui = await startUIServer({ workspace, port: 0 });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; let runRequests = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/run')) runRequests++; });
  await page.goto(ui.url);
  await page.waitForFunction(() => document.querySelector('#connection-label').textContent.includes('connected'));
  await page.locator('[data-view="library"]').click();
  await page.locator('#library-list .list-row').filter({ hasText: suite.title }).getByRole('button').click();
  await page.waitForFunction(() => !document.querySelector('#flow-input').disabled);
  await page.locator('#target-select').selectOption('demo');
  await page.locator('#review-checkbox').check();
  const draftBefore = await page.locator('#suite-editor').inputValue();
  const open = async (runId = report.runId) => {
    await page.locator('[data-view="history"]').click();
    await page.locator(`#history-list [data-run-id="${runId}"] [data-action="view-report"]`).click();
    await page.waitForFunction(id => document.querySelector('#report-heading').textContent.includes(id) && !document.querySelector('#flow-input').disabled, runId);
  };
  const cases = () => page.locator('#report-content .case-report');
  const clipboardMode = async mode => page.evaluate(mode => {
    window.copiedCaseIds = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'missing' ? undefined : {
      writeText(text) {
        window.copiedCaseIds.push(text);
        if (mode === 'reject') return Promise.reject(new Error('clipboard-private-error-sentinel'));
        if (mode === 'pending') return new Promise((resolve, reject) => { window.finishCaseCopy = { resolve, reject }; });
        return Promise.resolve();
      }
    } });
  }, mode);
  const search = query => page.locator('#report-case-search').fill(query);
  const status = value => page.locator('#report-case-status').selectOption(value);
  const sort = value => page.locator('#report-case-sort').selectOption(value);
  const caseIds = async () => (await cases().locator('h3').allTextContents()).map(heading => heading.split(' · ')[0]);
  const reset = () => page.locator('#report-case-reset').click();
  const download = async id => {
    const pending = page.waitForEvent('download'); await page.locator(id).click();
    return readFile(await (await pending).path(), 'utf8');
  };
  await open();
  assert.equal(await cases().count(), 6);
  const caseHeadings = await cases().locator('h3').allTextContents();
  assert.match(caseHeadings[0], / · 1 attempt$/);
  assert.match(caseHeadings[1], / · 2 attempts$/);
  assert.match(caseHeadings[2], / · 0 attempts$/);
  assert.equal(await cases().nth(0).locator('.case-attempt-time').textContent(), 'Total attempt time: 20ms');
  assert.equal(await cases().nth(1).locator('.case-attempt-time').textContent(), 'Total attempt time: 80ms');
  assert.equal(await cases().nth(2).locator('.case-attempt-time').count(), 0, 'No attempts must not imply a measured zero duration.');
  assert.equal(await page.locator('#report-content img').count(), 0);
  assert.match(await page.locator('#report-case-count').textContent(), /6/);
  assert.equal(await page.locator('#report-case-sort').inputValue(), 'recorded');
  assert.equal(await page.locator('#report-case-reset').isDisabled(), true);
  await sort('duration-desc');
  assert.deepEqual(await caseIds(), ['CASE-2', 'CASE-1', 'CASE-3', 'CASE-4', 'CASE-5', 'CASE-6']);
  assert.equal(await page.locator('#report-case-reset').isEnabled(), true, 'Sorting alone enables reset.');
  await sort('attempts-desc');
  assert.deepEqual(await caseIds(), ['CASE-2', 'CASE-1', 'CASE-3', 'CASE-4', 'CASE-5', 'CASE-6']);
  assert.equal(await page.locator('#report-case-sort option:checked').textContent(), 'Most attempts first');
  await page.locator('#language-select').selectOption('ko');
  assert.equal(await page.locator('#report-case-sort').inputValue(), 'attempts-desc');
  assert.equal(await page.locator('#report-case-sort option:checked').textContent(), '시도가 많은 순');
  await page.locator('#language-select').selectOption('en');
  await open();
  assert.equal(await page.locator('#report-case-sort').inputValue(), 'attempts-desc', 'Reopening the same report preserves attempt ordering.');
  for (const [index, value] of statuses.entries()) {
    await status(value);
    assert.equal(await cases().count(), 1, value);
    assert.ok((await cases().textContent()).includes(`CASE-${index + 1}`));
  }
  await status('failed-error'); assert.equal(await cases().count(), 2);
  await search('  case-2  '); assert.equal(await cases().count(), 1);
  assert.equal(await page.locator('#report-case-search').evaluate(input => input === document.activeElement), true, 'Typing keeps focus.');
  assert.match(await page.locator('#report-case-status option[value="failed-error"]').textContent(), /2/);
  assert.match(await page.locator('#report-case-count').textContent(), /1.*6|6.*1/);
  assert.match(await page.locator('#report-content').textContent(), /Whole report warning remains visible/);
  await clipboardMode('success');
  await cases().getByRole('button', { name: 'Copy case ID CASE-2', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.case-id-copy-status').textContent === 'Case ID copied.');
  assert.deepEqual(await page.evaluate(() => window.copiedCaseIds), ['CASE-2'], 'Only the case ID is copied after filtering and sorting.');
  for (const mode of ['reject', 'missing']) {
    await clipboardMode(mode);
    await cases().locator('.case-id-copy').click();
    await page.waitForFunction(() => document.querySelector('.case-id-copy-status').textContent.startsWith('Could not copy.'));
    assert.equal(await cases().locator('.case-id-copy').isEnabled(), true);
    assert.equal((await page.locator('body').textContent()).includes('clipboard-private-error-sentinel'), false);
  }
  const filteredJSON = JSON.parse(await download('#report-json'));
  assert.deepEqual(filteredJSON, report, 'JSON exports the complete original report while filtered.');
  const markdown = await download('#report-md');
  assert.equal(markdown, await readFile(path.join(reportDir, 'qa-report.md'), 'utf8'), 'Markdown exports the complete saved report while filtered.');
  const evidenceLink = cases().locator('a[href*="/api/artifact"]').first();
  const evidenceURL = new URL(await evidenceLink.getAttribute('href'), ui.url);
  assert.equal(evidenceURL.searchParams.get('caseId'), 'CASE-2');
  assert.equal(evidenceURL.searchParams.get('attempt'), '1');
  assert.equal(evidenceURL.searchParams.get('artifact'), '1');
  assert.equal(await (await fetch(evidenceURL)).text(), 'Approved evidence from original attempt 2 / artifact 2');
  await reset();
  assert.equal(await page.locator('#report-case-sort').inputValue(), 'recorded');
  assert.deepEqual(await caseIds(), report.cases.map(item => item.id));
  await clipboardMode('pending');
  await cases().nth(1).locator('.case-id-copy').click();
  assert.equal(await cases().nth(1).locator('.case-id-copy').isDisabled(), true);
  assert.equal(await cases().nth(0).locator('.case-id-copy').isEnabled(), true, 'Other case buttons remain available.');
  await search('case-1');
  await clipboardMode('success');
  await cases().locator('.case-id-copy').click();
  await page.waitForFunction(() => document.querySelector('.case-id-copy-status').textContent === 'Case ID copied.');
  await page.evaluate(async () => { window.finishCaseCopy.reject(new Error('late-private-error')); await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.equal(await cases().locator('.case-id-copy-status').textContent(), 'Case ID copied.', 'A detached copy response cannot overwrite a newer case message.');
  await search('');
  await clipboardMode('pending');
  await cases().nth(0).locator('.case-id-copy').click();
  await page.locator('[data-view="scenario"]').click();
  await page.locator('[data-view="history"]').click();
  await page.evaluate(async () => { window.finishCaseCopy.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.equal(await cases().nth(0).locator('.case-id-copy').isEnabled(), true);
  assert.equal(await cases().nth(0).locator('.case-id-copy-status').textContent(), '', 'Navigation invalidates late copy feedback.');
  await clipboardMode('success');
  for (const query of ['ASSERTION_MISMATCH', 'outer PACKET', 'STEP_MISMATCH', 'nested token', 'TEARDOWN_NOTE', 'secondary teardown', 'Attempt step 2']) {
    await search(query); assert.equal(await cases().count(), 1, query); assert.ok((await cases().textContent()).includes('CASE-2'));
  }
  await search('Unique expectation 4'); assert.equal(await cases().count(), 1);
  await search('seed FIXTURE'); assert.equal(await cases().count(), 1);
  await search('한국어'); assert.equal(await cases().count(), 1);
  await search('hidden-path-sentinel'); assert.equal(await cases().count(), 0, 'Artifact paths are not searchable case content.');
  await search('Outcome 1'); await status('failed-error'); assert.equal(await cases().count(), 0, 'Search and status intersect.');
  assert.match(await page.locator('#report-case-count').textContent(), /0.*6|6.*0/);
  assert.equal(await page.locator('#report-rerun').isEnabled(), true, 'Hidden failures remain eligible for preparation.');
  await reset(); assert.equal(await cases().count(), 6);
  await status('failed-error'); await search('case-2'); await sort('duration-desc');
  await page.locator('#language-select').selectOption('ko');
  assert.match(await cases().locator('h3').textContent(), / · 시도 2회$/);
  assert.equal(await cases().locator('.case-attempt-time').textContent(), '시도 시간 합계: 80ms');
  await cases().getByRole('button', { name: '케이스 ID CASE-2 복사', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.case-id-copy-status').textContent === '케이스 ID를 복사했습니다.');
  assert.deepEqual(await page.evaluate(() => window.copiedCaseIds), ['CASE-2']);
  assert.equal(await page.locator('#report-case-search').inputValue(), 'case-2');
  assert.equal(await page.locator('#report-case-status').inputValue(), 'failed-error');
  assert.equal(await page.locator('#report-case-sort').inputValue(), 'duration-desc');
  assert.equal(await page.locator('label[for="report-case-sort"]').textContent(), '케이스 정렬');
  assert.equal(await page.locator('#report-case-sort option:checked').textContent(), '시도 시간이 긴 순');
  assert.match(await page.locator('#report-case-status option[value="failed-error"]').textContent(), /실패.*오류.*2/);
  await page.locator('[data-view="scenario"]').click();
  assert.equal(await page.locator('#suite-editor').inputValue(), draftBefore);
  assert.equal(await page.locator('#review-checkbox').isChecked(), true, 'Report browsing preserves review confirmation.');
  await page.locator('[data-view="history"]').click();
  const refreshed = page.waitForResponse(response => response.url().endsWith('/api/state'));
  await page.locator('#reconnect-btn').click(); await refreshed;
  await page.locator('#history-search').fill('no-history-match');
  await page.waitForFunction(() => document.querySelector('#history-list').getAttribute('aria-busy') === 'false');
  assert.equal(await cases().count(), 1);
  assert.equal(await page.locator('#report-case-status').inputValue(), 'failed-error');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('#report-case-sort').inputValue(), 'duration-desc', 'Sort persists through navigation and refresh.');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('#report-panel').screenshot({ path: path.join(artifacts, 'report-explorer-ko-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#history-search').fill('');
  await page.waitForFunction(() => document.querySelector('#history-list').getAttribute('aria-busy') === 'false');
  await open();
  assert.equal(await page.locator('#report-case-search').inputValue(), 'case-2', 'Reloading the same report preserves filters.');
  assert.equal(await page.locator('#report-case-sort').inputValue(), 'duration-desc');
  const failedLoad = page.waitForResponse(response => response.url().includes('/api/report?') && response.url().includes(unreadable.runId));
  await page.locator(`#history-list [data-run-id="${unreadable.runId}"] [data-action="view-report"]`).click();
  assert.equal((await failedLoad).status(), 404);
  await page.waitForFunction(() => !document.querySelector('#flow-input').disabled);
  assert.equal(await page.locator('#report-case-search').inputValue(), 'case-2');
  assert.ok((await page.locator('#report-heading').textContent()).includes(report.runId));
  assert.equal(await page.locator('#report-case-sort').inputValue(), 'duration-desc', 'A failed load preserves sorting.');
  await open(partial.runId);
  assert.equal(await page.locator('#report-case-search').inputValue(), '');
  assert.equal(await page.locator('#report-case-status').inputValue(), 'all');
  assert.equal(await page.locator('#report-case-sort').inputValue(), 'recorded', 'Opening another report resets sorting.');
  assert.equal(await cases().count(), 2);
  assert.match(await page.locator('#report-case-count').textContent(), /2/);
  assert.match(await page.locator('#report-content .selection-scope').textContent(), /2.*6|6.*2/);
  await open(empty.runId);
  await sort('duration-desc');
  assert.equal(await cases().count(), 0);
  assert.match(await page.locator('#report-content').textContent(), /기록된.*없|케이스.*없/);
  await open(); await status('passed'); await sort('attempts-desc');
  const preparing = page.waitForResponse(response => response.url().includes('/api/rerun?'));
  await page.locator('#report-rerun').click();
  assert.equal((await preparing).status(), 200);
  await page.waitForFunction(() => !document.querySelector('#view-scenario').hidden && !document.querySelector('#flow-input').disabled);
  assert.deepEqual(await page.locator('#case-selection-list input:checked').evaluateAll(inputs => inputs.map(input => input.dataset.caseId)), ['CASE-2', 'CASE-3']);
  assert.equal(await page.locator('#review-checkbox').isChecked(), false);
  assert.equal(runRequests, 0, 'Exploration and preparation never start a run.');
  await page.locator('[data-view="history"]').click(); await reset();
  await page.locator('#language-select').selectOption('en'); await status('failed-error');
  await sort('attempts-desc');
  await page.locator('#report-panel').screenshot({ path: path.join(artifacts, 'report-explorer-en.png') });
  await open(durationEdges.runId);
  assert.equal(await cases().count(), durationEdgeAttempts.length);
  assert.equal(await cases().nth(1).locator('.case-attempt-time').textContent(), 'Total attempt time: 0ms');
  for (const index of [0, 2, 3, 4, 5, 6]) assert.equal(await cases().nth(index).locator('.case-attempt-time').count(), 0, `No misleading duration for edge fixture ${index}`);
  await sort('duration-desc');
  assert.deepEqual(await caseIds(), [7, 8, 9, 1, 10, 0, 2, 3, 4, 5, 6].map(index => `DURATION-${index}`), 'Valid totals sort descending, ties retain recorded order, and unknown totals follow valid zero.');
  assert.deepEqual(JSON.parse(await download('#report-json')), durationEdges, 'Sorting never mutates the exported report.');
  await sort('attempts-desc');
  assert.deepEqual(await caseIds(), [2, 6, 1, 3, 4, 5, 7, 8, 9, 10, 0].map(index => `DURATION-${index}`), 'Attempt ordering uses only recorded counts, preserves ties, and does not depend on valid timing.');
  assert.deepEqual(JSON.parse(await download('#report-json')), durationEdges, 'Attempt sorting keeps all recorded statuses and original export order.');
  await page.locator('#language-select').selectOption('ko');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('.report-case-filters').screenshot({ path: path.join(artifacts, 'attempt-sort-ko-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await reset();
  assert.equal(await page.locator('#report-case-sort').inputValue(), 'recorded');
  assert.deepEqual(await caseIds(), durationEdges.cases.map(item => item.id));
  await sort('attempts-desc'); await open(partial.runId);
  assert.equal(await page.locator('#report-case-sort').inputValue(), 'recorded', 'Another report clears attempt ordering.');
  await open(durationEdges.runId);
  await sort('recorded');
  assert.deepEqual(await caseIds(), durationEdges.cases.map(item => item.id));
  assert.deepEqual(errors, []);
  assert.deepEqual(JSON.parse(await readFile(path.join(reportDir, 'qa-report.json'), 'utf8')), report);
  const result = { fixtureStatuses: statuses.length, caseSearch: true, errorAndStepSearch: true, statusCounts: true, reportAttemptCount: true, reportAttemptTime: true,
    reportCopyCaseId: true, clipboardWrites: 'stubbed', clipboardFailures: true, staleCopyFeedbackIgnored: true,
    reportAttemptSort: true, reportDurationSort: true, stableDurationTies: true, unknownDurationsLast: true, combinedFilters: true, fullExportsPreserved: true, originalEvidenceIndices: true, fullRerunScope: true,
    sameReportPreservesFilters: true, newReportResetsFilters: true, failedLoadPreservesFilters: true,
    partialScope: true, emptyReport: true, draftAndReviewPreserved: true, bilingual: true, mobileOverflow: false, modelCalls: 0 };
  await writeFile(path.join(artifacts, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (browser) await browser.close();
  if (ui) await ui.close();
  await rm(workspace, { recursive: true, force: true });
}
