import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwrightInstallInvocation } from '../src/cli.ts';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/flow-qa.mjs', import.meta.url));
test('CLI supports a separate workspace, prompt handoff, validation and safe generation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-qa-cli-'));
  const qa = (...args: string[]) => exec(process.execPath, [bin, ...args, '--workspace', dir]);
  try {
    await qa('init');
    await qa('connect', 'preview', '--url', 'https://example.test');
    await qa('plan', 'flows/task-flow.md', '--prompt-only');
    const prompt = await readFile(join(dir, 'planning/task-flow.prompt.md'), 'utf8');
    assert.match(prompt, /flow-qa\/suite-1/);
    assert.match(prompt, /Create and filter tasks/);
    await qa('validate', 'cases/task-flow.json');
    await qa('generate', 'cases/task-flow.json');
    const before = await readFile(join(dir, 'generated/task-flow.e2e.ts'), 'utf8');
    assert.match(before, /\[TC-001\]/);
    await assert.rejects(qa('generate', 'cases/task-flow.json'), (e: unknown) => (e as { code: number }).code === 2);
    assert.equal(await readFile(join(dir, 'generated/task-flow.e2e.ts'), 'utf8'), before);
    await assert.rejects(qa('does-not-exist'), (e: unknown) => (e as { code: number }).code === 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI saves only generic model metadata and rejects removed provider options', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-qa-model-cli-'));
  const qa = (...args: string[]) => exec(process.execPath, [bin, ...args, '--workspace', dir], { env: { ...process.env, FLOW_QA_TEST_KEY: 'fixture-secret-never-write' } });
  try {
    await qa('init');
    await qa('model', 'planner', '--url', 'https://model.example/v1', '--model', 'test-model', '--key-env', 'FLOW_QA_TEST_KEY');
    const saved = await readFile(join(dir, 'flowqa.config.json'), 'utf8');
    const planner = JSON.parse(saved).planner;
    assert.deepEqual(planner, { baseURL: 'https://model.example/v1', model: 'test-model', apiKeyEnv: 'FLOW_QA_TEST_KEY' });
    assert.doesNotMatch(saved, /fixture-secret-never-write/);
    await assert.rejects(qa('model', 'agent', '--provider', 'unsupported-provider', '--url', 'https://model.example/v1', '--model', 'test-model'), (e: unknown) => {
      assert.equal((e as { code: number }).code, 2); return true;
    });
    assert.equal(await readFile(join(dir, 'flowqa.config.json'), 'utf8'), saved);
    await assert.rejects(qa('plan', 'flows/task-flow.md', '--ask-token'), (e: unknown) => {
      assert.equal((e as { code: number }).code, 2);
      assert.doesNotMatch((e as { stderr: string }).stderr, /fixture-secret-never-write/); return true;
    });
    const doctor = await qa('doctor');
    assert.match(doctor.stdout, /playwright: [0-9]+\.[0-9]+\.[0-9]+/);
    assert.match(doctor.stdout, /Chromium: (installed|missing)/);
    assert.doesNotMatch(doctor.stdout, /\/Users\/|\/private\/|fixture-secret-never-write/);
    await assert.rejects(qa('browser', 'other'), (e: unknown) => {
      assert.equal((e as { code: number }).code, 2); return true;
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('browser installer uses the installed Playwright CLI and opts into system dependencies explicitly', () => {
  const normal = playwrightInstallInvocation();
  assert.equal(normal.command, process.execPath);
  assert.match(normal.args[0]!, /playwright\/cli\.js$/);
  assert.deepEqual(normal.args.slice(1), ['install', 'chromium']);
  const withDeps = playwrightInstallInvocation(true);
  assert.equal(withDeps.command, process.execPath);
  assert.deepEqual(withDeps.args, [...normal.args, '--with-deps']);
});

test('CLI forwards UI options to the local entrypoint', async () => {
  const help = await exec(process.execPath, [bin, 'ui', '--help']);
  assert.match(help.stdout, /Flow QA UI/);
  assert.match(help.stdout, /flow-qa ui --demo/);
  await assert.rejects(exec(process.execPath, [bin, 'ui', '--port', 'invalid']), (error: unknown) => {
    assert.equal((error as { code: number }).code, 1);
    assert.match((error as { stderr: string }).stderr, /Port must/);
    return true;
  });
});

test('CLI defaults to English, supports Korean, and keeps generated example content in English', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-qa-lang-cli-'));
  const qa = (...args: string[]) => exec(process.execPath, [bin, ...args, '--workspace', dir], { env: { ...process.env, FLOW_QA_LANG: '' } });
  try {
    const english = await qa('init');
    assert.match(english.stdout, /Workspace: .*\nCreated:/);
    assert.match(await readFile(join(dir, 'flows/task-flow.md'), 'utf8'), /Task title/);
    const korean = await qa('validate', 'cases/task-flow.json', '--lang', 'ko');
    assert.match(korean.stdout, /3개 케이스 유효/);
    const englishAgain = await exec(process.execPath, [bin, 'validate', 'cases/task-flow.json', '--workspace', dir],
      { env: { ...process.env, FLOW_QA_LANG: 'ko' } });
    assert.match(englishAgain.stdout, /3개 케이스 유효/);
    const override = await exec(process.execPath, [bin, 'validate', 'cases/task-flow.json', '--workspace', dir, '--lang', 'en'],
      { env: { ...process.env, FLOW_QA_LANG: 'ko' } });
    assert.match(override.stdout, /3 valid cases/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
