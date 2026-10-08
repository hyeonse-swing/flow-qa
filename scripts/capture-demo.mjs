#!/usr/bin/env node
// Capture the real English Flow QA demo UI and its three-case Chromium report.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startDemo } from '../examples/demo/server.ts';
import { startUIServer } from '../src/ui/server.ts';
import { configSchema } from '../src/schema.ts';
import { initWorkspace, writeJSON } from '../src/workspace.ts';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'docs/media');
const workspace = await mkdtemp(path.join(tmpdir(), 'flowqa-capture-'));
let demo;
let ui;
let browser;
const pageErrors = [];
try {
  await initWorkspace(workspace);
  demo = await startDemo(0);
  await writeJSON(path.join(workspace, 'flowqa.config.json'), configSchema.parse({
    schemaVersion: 'flow-qa/config-1',
    targets: { demo: { url: demo.url, description: 'Local to-do example · temporary data' } },
    timeoutMs: 15_000, retries: 0,
  }));
  ui = await startUIServer({ workspace, port: 0 });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, colorScheme: 'light',
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.protocol === 'data:') return route.continue();
    return route.abort();
  });
  await page.goto(ui.url, { waitUntil: 'domcontentloaded' });
  await page.locator('#connection-dot.ready').waitFor();
  assert.equal(await page.locator('#language-select').inputValue(), 'en');

  await page.locator('[data-view="library"]').click();
  await page.locator('#library-list .list-row').first().waitFor();
  await page.locator('#library-list button').first().click();
  await page.locator('#draft-summary .case-review').first().waitFor();
  const stats = await page.locator('#draft-summary .summary-stat strong').allTextContents();
  assert.deepEqual(stats, ['3', '3', '0'], `Expected three cases, three requirements, no open questions: ${stats}`);
  assert.match(await page.locator('#view-scenario h1').textContent(), /Write a flow,\s*keep the evidence\./);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'flow-qa-demo.png') });

  await page.locator('#target-select').selectOption('demo');
  await page.locator('#review-checkbox').check();
  assert.equal(await page.locator('#run-btn').isEnabled(), true);
  await page.locator('#run-btn').click();
  await page.locator('[data-view="history"]').click();
  await page.locator('#history-list .list-row strong').first().filter({ hasText: /passed/i }).waitFor({ timeout: 60_000 });
  await page.locator('#history-list button').first().click();
  await page.locator('#report-panel').waitFor({ state: 'visible' });
  const headings = await page.locator('#report-content .case-report h3').allTextContents();
  assert.equal(headings.length, 3, `Expected three report cases: ${headings.join(' | ')}`);
  assert.ok(headings.every((heading) => / · passed$/i.test(heading)), `Expected all three passed: ${headings.join(' | ')}`);
  assert.match(await page.locator('#report-heading').textContent(), / · passed · demo/i);
  const runsDir = path.join(workspace, '.flowqa/runs');
  const runDirs = (await readdir(runsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  assert.equal(runDirs.length, 1);
  const report = JSON.parse(await readFile(path.join(runsDir, runDirs[0].name, 'qa-report.json'), 'utf8'));
  assert.equal(report.status, 'passed');
  assert.equal(report.cases.filter((item) => item.status === 'passed').length, 3);
  assert.deepEqual(pageErrors, [], `Browser errors: ${pageErrors.join(' | ')}`);
  await page.locator('#report-panel').screenshot({ path: path.join(output, 'flow-qa-report.png') });
  console.log(JSON.stringify({ status: report.status, cases: headings, browserErrors: pageErrors, screenshots: ['docs/media/flow-qa-demo.png', 'docs/media/flow-qa-report.png'] }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  await ui?.close().catch(() => {});
  await demo?.close().catch(() => {});
  await rm(workspace, { recursive: true, force: true });
}
