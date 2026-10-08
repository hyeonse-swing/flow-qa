import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startDemo } from '../examples/demo/server.ts';
import { startUIServer } from '../src/ui/server.ts';
import { initWorkspace, writeJSON } from '../src/workspace.ts';

const workspace = await mkdtemp(path.join(tmpdir(), 'flowqa-i18n-'));
const artifacts = path.resolve('output/playwright/i18n');
await mkdir(artifacts, { recursive: true });
let demo; let ui; let browser;
try {
  await initWorkspace(workspace);
  demo = await startDemo(0);
  await writeJSON(path.join(workspace, 'flowqa.config.json'), {
    schemaVersion: 'flow-qa/config-1', targets: { demo: { url: demo.url, description: 'Local demo · 임의 사용자 설명' } },
    timeoutMs: 15_000, retries: 0,
  });
  ui = await startUIServer({ workspace, port: 0 });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', colorScheme: 'light' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(ui.url);
  await page.waitForFunction(() => document.querySelector('#connection-label').textContent.includes('connected'));
  assert.equal(await page.locator('html').getAttribute('lang'), 'en', 'First visit defaults to English even in a Korean browser.');
  await page.locator('[data-view="library"]').click();
  await page.locator('#library-list button').first().click();
  await page.locator('#draft-summary .case-review').first().waitFor();
  const flow = await page.locator('#flow-input').inputValue();
  const suite = await page.locator('#suite-editor').inputValue();
  await page.locator('#target-select').selectOption('demo');
  await page.locator('#review-checkbox').check();
  assert.equal(await page.locator('#run-btn').isEnabled(), true);

  await page.locator('[data-view="settings"]').click();
  await page.locator('#target-form [name="name"]').fill('unsaved-target');
  await page.locator('#target-form [name="description"]').fill('Keep 사용자 입력 <b>literal</b>');
  const modelInput = page.locator('#model-forms [name="model"]').first();
  await modelInput.fill('unsaved-model');
  const tab = await context.newPage();
  await tab.goto(ui.url);
  await page.locator('#language-select').selectOption('ko');
  await tab.waitForFunction(() => document.documentElement.lang === 'ko');
  assert.equal(await page.locator('html').getAttribute('lang'), 'ko');
  assert.equal(await page.locator('#target-form [name="name"]').inputValue(), 'unsaved-target');
  assert.equal(await page.locator('#target-form [name="description"]').inputValue(), 'Keep 사용자 입력 <b>literal</b>');
  assert.equal(await modelInput.inputValue(), 'unsaved-model');
  assert.equal(await page.locator('#flow-input').inputValue(), flow);
  assert.equal(await page.locator('#suite-editor').inputValue(), suite);
  assert.equal(await page.locator('#review-checkbox').isChecked(), true);
  assert.equal(await page.locator('#target-select').inputValue(), 'demo');
  await page.screenshot({ path: path.join(artifacts, 'settings-ko.png'), fullPage: true });
  await tab.reload();
  assert.equal(await tab.locator('html').getAttribute('lang'), 'ko', 'Saved locale survives reload.');
  await page.locator('#language-select').selectOption('en');
  await tab.waitForFunction(() => document.documentElement.lang === 'en');
  await tab.close();
  await page.locator('[data-view="scenario"]').click();
  await page.screenshot({ path: path.join(artifacts, 'scenario-en.png'), fullPage: true });
  await page.locator('#run-btn').click();
  await page.locator('#language-select').selectOption('ko');
  let state;
  const deadline = Date.now() + 90_000;
  do {
    await new Promise(resolve => setTimeout(resolve, 400));
    state = await (await fetch(ui.url + '/api/state')).json();
  } while ((state.active || !state.lastRunId) && Date.now() < deadline);
  assert.equal(state.active, null);
  assert.ok(state.lastRunId, 'Changing locale must not cancel the actual run.');
  const report = JSON.parse(await readFile(path.join(workspace, '.flowqa/runs', state.lastRunId, 'qa-report.json'), 'utf8'));
  assert.equal(report.status, 'passed');
  assert.equal(report.cases.filter(item => item.status === 'passed').length, 3);
  await page.locator('[data-view="history"]').click();
  await page.locator('#history-list button').first().click();
  await page.locator('#report-content .case-report').first().waitFor();
  await page.screenshot({ path: path.join(artifacts, 'report-ko.png'), fullPage: true });
  const downloadReport = async () => {
    const event = page.waitForEvent('download');
    await page.locator('#report-md').click();
    const download = await event;
    return readFile(await download.path(), 'utf8');
  };
  assert.match(await downloadReport(), /^# QA 결과:/);
  await page.locator('#language-select').selectOption('en');
  assert.match(await downloadReport(), /^# QA results:/);
  await page.screenshot({ path: path.join(artifacts, 'report-en.png'), fullPage: true });
  assert.equal(await page.locator('#report-content .case-report').count(), 3);
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, 'English UI must fit the mobile viewport.');
  await page.screenshot({ path: path.join(artifacts, 'mobile-en.png'), fullPage: true });
  assert.deepEqual(errors, [], 'No browser runtime errors.');
  const evidence = { defaultLanguage: 'en', languages: ['en', 'ko'], persistence: true, crossTab: true, userInputPreserved: true, reviewPreserved: true, reportDownloadLocale: true, realBrowserCases: 3, status: report.status, mobileOverflow: false, modelCalls: 0 };
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser?.close(); await ui?.close(); await demo?.close();
  await rm(workspace, { recursive: true, force: true });
}
