import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { initWorkspace } from '../src/workspace.ts';
import { startUIServer } from '../src/ui/server.ts';

const workspace = await mkdtemp(path.join(tmpdir(), 'flowqa-preferences-'));
const artifacts = path.resolve('output/playwright/preferences');
await mkdir(artifacts, { recursive: true });
let browser; let ui;
const errors = [];
const storageKey = 'flowqa-display-preferences';
async function open(context) {
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(ui.url);
  await page.waitForFunction(() => document.querySelector('#connection-label').textContent.includes('connected'));
  await page.locator('[data-view="settings"]').click();
  return page;
}
try {
  await initWorkspace(workspace);
  ui = await startUIServer({ workspace, port: 0 });
  browser = await chromium.launch({ headless: true });
  const blocked = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  await blocked.addInitScript(key => {
    window.failPreferenceWrite = true;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key && window.failPreferenceWrite) throw new DOMException('Storage disabled in fixture', 'QuotaExceededError');
      return original.call(this, name, value);
    };
  }, storageKey);
  const page = await open(blocked);
  await page.locator('input[name="accent"][value="forest"]').check();
  assert.equal(await page.locator('html').getAttribute('data-accent'), 'forest', 'Failed persistence must still apply the current choice.');
  assert.match(await page.locator('#preferences-storage-status').textContent({ timeout: 2000 }), /only.*tab/i);
  assert.equal(await page.locator('#preferences-storage-status').isVisible(), true);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), null);
  await page.locator('#language-select').selectOption('ko');
  assert.match(await page.locator('#preferences-storage-status').textContent(), /현재 탭/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.documentElement.dataset.motion === 'reduced');
  assert.equal(await page.locator('#preferences-storage-status').isVisible(), true, 'Media changes must not erase the warning.');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('#display-preferences').screenshot({ path: path.join(artifacts, 'storage-unavailable-ko-mobile.png') });
  await page.evaluate(() => { window.failPreferenceWrite = false; });
  await page.locator('input[name="theme"][value="light"]').focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.documentElement.dataset.themePreference === 'dark');
  assert.equal(await page.locator('#preferences-storage-status').isHidden(), true, 'A successful write clears the warning.');
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.themePreference === 'dark');
  assert.equal(await page.locator('html').getAttribute('data-accent'), 'forest');
  await blocked.close();

  const normal = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const first = await open(normal);
  const second = await open(normal);
  await first.locator('input[name="theme"][value="dark"]').check();
  await second.waitForFunction(() => document.documentElement.dataset.themePreference === 'dark');
  await second.locator('input[name="accent"][value="coral"]').check();
  await first.waitForFunction(() => document.documentElement.dataset.accent === 'coral');
  assert.equal(await first.locator('#preferences-storage-status').isHidden(), true);
  await first.evaluate(key => {
    const altered = { ...JSON.parse(localStorage.getItem(key)), theme: 'light' };
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(altered), storageArea: sessionStorage }));
  }, storageKey);
  assert.equal(await first.locator('html').getAttribute('data-theme-preference'), 'dark', 'Session storage must not replace shared display preferences.');
  await first.emulateMedia({ reducedMotion: 'reduce' });
  await first.locator('input[name="motion"][value="full"]').check();
  await first.waitForFunction(() => document.documentElement.dataset.motion === 'reduced');
  await first.locator('#reset-preferences').click();
  await second.waitForFunction(() => document.documentElement.dataset.themePreference === 'system' && document.documentElement.dataset.accent === 'cobalt');
  await first.locator('#display-preferences').screenshot({ path: path.join(artifacts, 'preferences-en-desktop.png') });
  await first.evaluate(() => localStorage.clear());
  await second.waitForFunction(() => document.documentElement.dataset.themePreference === 'system');
  await normal.close();

  const unreadable = await browser.newContext();
  await unreadable.addInitScript(key => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function (name) {
      if (name === key) throw new DOMException('Storage read disabled in fixture', 'SecurityError');
      return original.call(this, name);
    };
  }, storageKey);
  const fallback = await open(unreadable);
  assert.equal(await fallback.locator('html').getAttribute('data-theme-preference'), 'system');
  assert.equal(await fallback.locator('#preferences-storage-status').isVisible(), true);
  await unreadable.close();
  assert.deepEqual(errors, []);
  const evidence = { result: 'passed', blockedWrite: true, blockedRead: true, retryClearsWarning: true,
    currentTabStillUsable: true, reloadPersistence: true, crossTab: true, unrelatedStorageIgnored: true,
    keyboard: true, reducedMotion: true, locales: ['en', 'ko'], mobileOverflow: false, modelCalls: 0 };
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser?.close(); await ui?.close();
  await rm(workspace, { recursive: true, force: true });
}
