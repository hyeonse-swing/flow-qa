import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, open, readdir, readlink, rename, rm, stat, symlink, unlink, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from '../src/schema.ts';
import { initWorkspace, readConfig, readSuite, verifySuiteSource, writeConfig } from '../src/workspace.ts';

test('init yields a runnable example and never overwrites existing user files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-qa-workspace-'));
  try {
    const created = await initWorkspace(dir);
    assert.equal(created.length, 5);
    assert.equal((await readConfig(dir)).targets.demo?.url, 'http://127.0.0.1:4178');
    assert.equal((await readSuite(join(dir, 'cases/task-flow.json'))).cases.length, 3);
    const suite = await readSuite(join(dir, 'cases/task-flow.json'));
    await verifySuiteSource(suite, dir);
    await writeFile(join(dir, 'flows/task-flow.md'), 'User owned flow');
    assert.deepEqual(await initWorkspace(dir), []);
    assert.equal(await readFile(join(dir, 'flows/task-flow.md'), 'utf8'), 'User owned flow');
    await assert.rejects(verifySuiteSource(suite, dir), /STALE_SUITE/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('existing ignore files remain intact while private run storage has its own ignore rule', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-qa-ignore-'));
  try {
    await writeFile(join(dir, '.gitignore'), 'user-rule/\n');
    await initWorkspace(dir);
    assert.equal(await readFile(join(dir, '.gitignore'), 'utf8'), 'user-rule/\n');
    assert.equal(await readFile(join(dir, '.flowqa/.gitignore'), 'utf8'), '*\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('config save replaces complete JSON and keeps private permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-qa-config-'));
  try {
    await initWorkspace(dir);
    const file = join(dir, 'flowqa.config.json');
    if (process.platform !== 'win32') await chmod(file, 0o644);
    const next = { ...await readConfig(dir), retries: 1 };
    await writeConfig(dir, next);
    assert.deepEqual(await readConfig(dir), next);
    assert.equal(await readFile(file, 'utf8'), `${JSON.stringify(next, null, 2)}\n`);
    assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith('.flowqa-config-')), []);
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o077, 0);
    await unlink(file);
    const created = { ...next, retries: 2 };
    await writeConfig(dir, created);
    assert.deepEqual(await readConfig(dir), created);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('config save follows existing relative and absolute symlinks', { skip: process.platform === 'win32' }, async (t) => {
  for (const kind of ['relative', 'absolute'] as const) {
    await t.test(kind, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'flow-qa-config-link-'));
      try {
        const workspace = join(dir, 'workspace');
        const targetDir = join(dir, 'target');
        await initWorkspace(workspace);
        await mkdir(targetDir);
        const alias = join(workspace, 'flowqa.config.json');
        const target = join(targetDir, 'actual-config.json');
        await rename(alias, target);
        const link = kind === 'relative' ? '../target/actual-config.json' : target;
        await symlink(link, alias);
        const next = { ...await readConfig(workspace), retries: 1 };
        await writeConfig(workspace, next);
        assert.equal(await readlink(alias), link);
        assert.deepEqual(await readConfig(workspace), next);
        assert.equal(await readFile(target, 'utf8'), `${JSON.stringify(next, null, 2)}\n`);
        assert.deepEqual((await readdir(targetDir)).filter((name) => name.startsWith('.flowqa-config-')), []);
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
  }
});

test('config save leaves a dangling symlink intact', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-qa-config-link-'));
  try {
    await initWorkspace(dir);
    const config = await readConfig(dir);
    const alias = join(dir, 'flowqa.config.json');
    await unlink(alias);
    await symlink('missing-config.json', alias);
    await assert.rejects(writeConfig(dir, config), /symlink target does not exist/);
    assert.equal(await readlink(alias), 'missing-config.json');
    assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith('.flowqa-config-')), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failed config sync preserves the old file and removes its temporary file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-qa-config-'));
  try {
    await initWorkspace(dir);
    const file = join(dir, 'flowqa.config.json');
    const before = await readFile(file, 'utf8');
    const probe = join(dir, 'probe');
    const handle = await open(probe, 'wx', 0o600);
    const fileHandlePrototype = Object.getPrototypeOf(handle) as { sync: typeof handle.sync };
    await handle.close();
    await unlink(probe);
    t.mock.method(fileHandlePrototype, 'sync', async () => { throw new Error('simulated sync failure'); });
    await assert.rejects(writeConfig(dir, { ...await readConfig(dir), retries: 1 }), /simulated sync failure/);
    assert.equal(await readFile(file, 'utf8'), before);
    assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith('.flowqa-config-')), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid circular config is rejected before creating a temporary file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-qa-config-'));
  try {
    await initWorkspace(dir);
    const file = join(dir, 'flowqa.config.json');
    const before = await readFile(file, 'utf8');
    const invalid: Config & { self?: unknown } = await readConfig(dir);
    invalid.self = invalid;
    await assert.rejects(writeConfig(dir, invalid));
    assert.equal(await readFile(file, 'utf8'), before);
    assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith('.flowqa-config-')), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
