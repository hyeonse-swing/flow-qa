#!/usr/bin/env node
// Records the real local Flow QA UI and its deterministic three-case browser run.
// Run from the repository root with Node.js 24 and an installed Chromium.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { startDemo } from '../examples/demo/server.ts';
import { startUIServer } from '../src/ui/server.ts';
import { configSchema } from '../src/schema.ts';
import { initWorkspace, writeJSON } from '../src/workspace.ts';

const root = path.resolve(import.meta.dirname, '..');
const mediaDir = path.join(root, 'docs/media');
const scratchRoot = path.join(root, 'output/playwright/recording');
const width = 1440;
const height = 900;
const ffmpeg = process.env.FLOWQA_FFMPEG;
if (!ffmpeg) throw new Error('Set FLOWQA_FFMPEG to a local ffmpeg binary; no permanent dependency is needed.');

async function exec(file, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${file} exited ${code}`)));
  });
}

await mkdir(mediaDir, { recursive: true });
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(path.join(scratchRoot, 'demo-'));
const workspace = path.join(scratch, 'workspace');
await mkdir(workspace);
await initWorkspace(workspace);
let demo;
let ui;
let browser;
let context;
let video;
const started = Date.now();
const pauseUntil = async (seconds) => {
  const remaining = seconds * 1000 - (Date.now() - started);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
};
const captions = [
  { start: 0, end: 5, text: 'Flow QA · from user flow to verified evidence' },
  { start: 5, end: 12, text: 'Three local cases · reproducible without a model' },
  { start: 12, end: 23, text: 'Review requirements, actions, and expected results' },
  { start: 23, end: 32, text: 'Choose a target and approve the cases before running' },
  { start: 32, end: 46, text: 'Real Chromium execution · waiting for the report' },
  { start: 46, end: 53, text: 'Three passing cases with run-by-run evidence' },
  { start: 53, end: 60, text: 'Switch to Korean without changing the work' },
  { start: 60, end: 65, text: 'Return to English · planner and agent stay separate' },
];
function timecode(seconds) {
  const ms = Math.round(seconds * 1000);
  return `00:${String(Math.floor(ms / 60)).padStart(2, '0')}:${String(Math.floor(ms % 60)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
try {
  demo = await startDemo(0);
  await writeJSON(path.join(workspace, 'flowqa.config.json'), configSchema.parse({
    schemaVersion: 'flow-qa/config-1', targets: { demo: { url: demo.url, description: 'Local to-do example · temporary data' } },
    timeoutMs: 15_000, retries: 0,
  }));
  ui = await startUIServer({ workspace, port: 0 });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'light', bypassCSP: true,
    recordVideo: { dir: scratch, size: { width, height } },
  });
  const page = await context.newPage();
  video = page.video();
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.protocol === 'data:') return route.continue();
    return route.abort();
  });
  await page.goto(ui.url, { waitUntil: 'domcontentloaded' });
  await page.locator('#connection-dot.ready').waitFor();
  assert.equal(await page.locator('#language-select').inputValue(), 'en', 'The demo must start in English.');
  await page.addStyleTag({ content: `
    #portfolio-caption { position:fixed; z-index:9999; left:316px; right:28px; bottom:16px; padding:13px 20px;
      border-radius:12px; color:#fff; background:rgba(15,31,46,.88); box-shadow:0 8px 24px rgba(0,0,0,.16);
      font:600 22px/1.35 system-ui,sans-serif; letter-spacing:-.02em; pointer-events:none; }
  ` });
  await page.evaluate(() => { const caption = document.createElement('div'); caption.id = 'portfolio-caption'; document.body.append(caption); });
  const show = async (value) => page.locator('#portfolio-caption').evaluate((el, text) => { el.textContent = text; }, value);
  const frame = async (seconds, caption) => { await show(caption); await pauseUntil(seconds); };

  await frame(5, captions[0].text);
  await page.locator('[data-view="library"]').click();
  await page.locator('#library-list .list-row').getByText('task-flow', { exact: false }).waitFor();
  await frame(10, captions[1].text);
  await page.locator('#library-list button').first().click();
  await page.locator('#draft-summary .case-review').first().waitFor();
  await page.locator('#draft-title').scrollIntoViewIfNeeded();
  await frame(17, captions[2].text);
  await page.locator('#draft-summary .case-review').nth(1).locator('summary').click();
  await pauseUntil(19);
  await page.locator('#draft-summary .case-review').nth(2).locator('summary').click();
  await pauseUntil(21);
  await page.locator('#draft-summary .case-review').first().scrollIntoViewIfNeeded();
  await frame(23, captions[2].text);

  await page.locator('#target-select').selectOption('demo');
  await page.locator('#review-checkbox').check();
  await page.locator('#run-title').scrollIntoViewIfNeeded();
  await show(captions[3].text);
  assert.equal(await page.locator('#run-btn').isEnabled(), true);
  await pauseUntil(29);
  await page.locator('#run-btn').click();
  await page.locator('[data-view="history"]').click();
  await show(captions[4].text);
  await page.locator('#history-list .list-row').first().waitFor({ timeout: 60_000 });
  await page.locator('#history-list .list-row strong').first().filter({ hasText: /passed/i }).waitFor({ timeout: 60_000 });
  await page.locator('#history-list button').first().click();
  await page.locator('#report-panel').waitFor({ state: 'visible' });
  const headings = await page.locator('#report-content .case-report h3').allTextContents();
  assert.equal(headings.length, 3, `Expected three report cases: ${headings.join(' | ')}`);
  assert.ok(headings.every((heading) => / · passed$/i.test(heading)), `Expected all cases passed: ${headings.join(' | ')}`);
  assert.match(await page.locator('#report-heading').textContent(), / · passed · demo/i);
  const runFiles = await import('node:fs/promises').then(async (fs) => (await fs.readdir(path.join(workspace, '.flowqa/runs'), { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name));
  assert.equal(runFiles.length, 1, `Expected one real run: ${runFiles}`);
  const report = JSON.parse(await readFile(path.join(workspace, '.flowqa/runs', runFiles[0], 'qa-report.json'), 'utf8'));
  assert.equal(report.status, 'passed');
  assert.equal(report.cases.filter((item) => item.status === 'passed').length, 3);
  await show(captions[5].text);
  await pauseUntil(53);
  await page.locator('[data-view="settings"]').click();
  await page.locator('#language-select').scrollIntoViewIfNeeded();
  await show(captions[6].text);
  await pauseUntil(56);
  await page.locator('#language-select').selectOption('ko');
  await page.waitForFunction(() => document.querySelector('[data-view="settings"]')?.textContent?.includes('연결 설정'));
  assert.equal(await page.evaluate(() => localStorage.getItem('flowqa-language')), 'ko');
  await pauseUntil(60);
  await show(captions[7].text);
  await page.locator('#language-select').selectOption('en');
  await page.waitForFunction(() => document.querySelector('[data-view="settings"]')?.textContent?.includes('Connections'));
  assert.equal(await page.evaluate(() => localStorage.getItem('flowqa-language')), 'en');
  await page.locator('#model-forms').scrollIntoViewIfNeeded();
  await pauseUntil(65);
  const elapsed = (Date.now() - started) / 1000;
  if (elapsed > 70) throw new Error(`Recording exceeded 70 seconds (${elapsed.toFixed(1)}s); review scene timing.`);
  await context.close(); context = undefined;
  const raw = await video.path();
  await exec(ffmpeg, ['-y', '-i', raw, '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(mediaDir, 'flow-qa-demo.mp4')]);
  // The actual 11-second frame shows the full scenario title and the loaded 3/3/0 review summary.
  await exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '11', '-i', path.join(mediaDir, 'flow-qa-demo.mp4'), '-frames:v', '1', path.join(mediaDir, 'flow-qa-demo.png')]);
  const vtt = ['WEBVTT', '', ...captions.flatMap((item) => [`${timecode(item.start)} --> ${timecode(item.end)}`, item.text, ''])].join('\n');
  await import('node:fs/promises').then((fs) => fs.writeFile(path.join(mediaDir, 'flow-qa-demo.vtt'), vtt));
  console.log(JSON.stringify({ elapsedSeconds: elapsed, reportStatus: report.status, cases: headings, video: 'docs/media/flow-qa-demo.mp4', poster: 'docs/media/flow-qa-demo.png' }, null, 2));
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await ui?.close().catch(() => {});
  await demo?.close().catch(() => {});
  await rm(scratch, { recursive: true, force: true });
}
