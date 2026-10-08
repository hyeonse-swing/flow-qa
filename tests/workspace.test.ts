import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initWorkspace, readConfig, readSuite, verifySuiteSource } from '../src/workspace.ts';

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
