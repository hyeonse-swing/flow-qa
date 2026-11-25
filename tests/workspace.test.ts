import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, open, readdir, readlink, realpath, rename, rm, stat, symlink, unlink, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/schema.ts';
import { initWorkspace, readConfig, readSuite, sha256, verifySuiteSource, withConfigLock, writeConfig } from '../src/workspace.ts';

test('configuration lock is released by the OS after a writer exits', { skip: process.platform === 'win32' }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'flow-qa-lock-exit-'));
  await initWorkspace(workspace);
  const modulePath = fileURLToPath(new URL('../src/workspace.ts', import.meta.url));
  const script = `import { withConfigLock } from ${JSON.stringify(modulePath)};
    await withConfigLock(${JSON.stringify(workspace)}, async () => {
      process.stdout.write('LOCKED\\n');
      await new Promise(() => setInterval(() => {}, 1000));
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Child did not acquire the configuration lock.')), 5_000);
      child.stdout.once('data', data => { clearTimeout(timeout); data.toString().includes('LOCKED') ? resolve() : reject(new Error('Unexpected child output.')); });
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Child exited before acquiring the configuration lock.')));
    });
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
    await withConfigLock(workspace, async () => {
      const settings = await readConfig(workspace);
      settings.retries = 2;
      await writeConfig(workspace, settings);
    });
    assert.equal((await readConfig(workspace)).retries, 2);
    const locks = (await readdir(join(workspace, '.flowqa'))).filter(name => name.startsWith('config-lock-'));
    assert.equal(locks.length, 1);
    if (process.platform !== 'win32') assert.equal((await stat(join(workspace, '.flowqa', locks[0]!))).mode & 0o077, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(workspace, { recursive: true, force: true });
  }
});

test('configuration aliases share the same lock for updates to one target file', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'flow-qa-config-alias-'));
  const first = join(root, 'first');
  const second = join(root, 'second');
  const shared = join(root, 'shared.json');
  try {
    await initWorkspace(first);
    await initWorkspace(second);
    await rename(join(first, 'flowqa.config.json'), shared);
    await unlink(join(second, 'flowqa.config.json'));
    await symlink(shared, join(first, 'flowqa.config.json'));
    await symlink(shared, join(second, 'flowqa.config.json'));
    await Promise.all([first, second].map(async (workspace, index) => withConfigLock(workspace, async () => {
      const settings = await readConfig(workspace);
      settings.targets[`alias${index}`] = { url: `https://alias${index}.example.com`, description: '' };
      await new Promise(resolveDelay => setTimeout(resolveDelay, 80));
      await writeConfig(workspace, settings);
    })));
    const settings = await readConfig(first);
    assert.deepEqual(Object.keys(settings.targets).sort(), ['alias0', 'alias1', 'demo']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('another local writer cannot release the first writer’s SQLite lock', { skip: process.platform === 'win32' }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'flow-qa-lock-overlap-'));
  await initWorkspace(workspace);
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const holdFirst = new Promise<void>(resolveHold => { releaseFirst = resolveHold; });
  const enteredFirst = new Promise<void>(resolveEntered => { firstEntered = resolveEntered; });
  const first = withConfigLock(workspace, async () => { firstEntered(); await holdFirst; });
  await enteredFirst;
  const second = withConfigLock(workspace, async () => {});
  const modulePath = fileURLToPath(new URL('../src/workspace.ts', import.meta.url));
  const script = `import { withConfigLock } from ${JSON.stringify(modulePath)};
    process.stdout.write('STARTED\\n');
    await withConfigLock(${JSON.stringify(workspace)}, async () => process.stdout.write('ENTERED\\n'));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  try {
    await new Promise<void>((resolveStarted, reject) => {
      const timeout = setTimeout(() => reject(new Error('Child did not start.')), 5_000);
      child.stdout.on('data', () => { if (output.includes('STARTED')) { clearTimeout(timeout); resolveStarted(); } });
      child.once('error', reject);
    });
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
    assert.equal(output.includes('ENTERED'), false);
    const exited = once(child, 'exit');
    releaseFirst();
    await Promise.all([first, second, exited]);
    assert.equal(output.includes('ENTERED'), true);
  } finally {
    releaseFirst();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.allSettled([first, second]);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('configuration lock refuses a symlink and leaves its destination untouched', { skip: process.platform === 'win32' }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'flow-qa-lock-path-'));
  try {
    await initWorkspace(workspace);
    const target = join(workspace, 'unrelated.txt');
    await writeFile(target, 'keep this file');
    const config = await realpath(join(workspace, 'flowqa.config.json'));
    const lockFile = join(workspace, '.flowqa', `config-lock-${sha256(config)}.sqlite`);
    await symlink(target, lockFile);
    await assert.rejects(withConfigLock(workspace, async () => {}), /ELOOP|Invalid configuration lock file/);
    assert.equal(await readFile(target, 'utf8'), 'keep this file');
    await unlink(lockFile);
    await mkdir(lockFile);
    await assert.rejects(withConfigLock(workspace, async () => {}), /EISDIR|Invalid configuration lock file/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('a missing configuration still advises initialization before acquiring a lock', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'flow-qa-missing-config-'));
  try {
    await assert.rejects(withConfigLock(workspace, async () => {}), /Run flow-qa init first/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('init yields a runnable example and never overwrites existing user files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-qa-workspace-'));
  try {
    const created = await initWorkspace(dir);
    assert.equal(created.length, 5);
    const target = (await readConfig(dir)).targets.demo;
    assert.ok(target && target.kind !== 'mobile');
    assert.equal(target.url, 'http://127.0.0.1:4178');
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
