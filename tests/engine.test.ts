import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runSuite } from '../src/engine.ts';
import type { Config, Suite } from '../src/schema.ts';

const config: Config = {
  schemaVersion: 'flow-qa/config-1', targets: { local: { url: 'http://127.0.0.1:1', description: '' } }, timeoutMs: 1_000, retries: 0,
};

function suite(title: string, question = true): Suite {
  return {
    schemaVersion: 'flow-qa/suite-1', id: 'sample', title: 'Sample',
    requirements: [{ id: 'R1', text: 'First requirement' }],
    cases: [{ id: 'C1', title, requirementIds: ['R1'], preconditions: [], questions: question ? ['Which user?'] : [],
      steps: question ? [{ type: 'open', path: '/' }] : [{ type: 'assertUrl', expected: 'http://127.0.0.1:1/' }] }],
  };
}

test('every invocation creates a unique run and never reuses a previous report', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-engine-'));
  const first = await runSuite({ workspace, suite: suite('question'), config, targetName: 'local' });
  writeFileSync(path.join(first.runDir, 'raw-stale-report.json'), JSON.stringify({ status: 'passed' }));
  const second = await runSuite({ workspace, suite: suite('question'), config, targetName: 'local' });
  assert.notEqual(first.runDir, second.runDir);
  assert.equal(second.report.status, 'blocked');
  assert.equal(second.report.cases[0]?.status, 'blocked');
  assert.equal(second.report.cases[0]?.attempts.length, 0);
  assert.equal(JSON.parse(readFileSync(path.join(second.runDir, 'qa-report.json'), 'utf8')).runId, second.report.runId);
  assert.match(readFileSync(path.join(second.runDir, 'suite.sha256'), 'utf8'), /^[a-f0-9]{64}\n$/);
  assert.ok(readFileSync(path.join(second.runDir, 'qa-report.md'), 'utf8').includes('blocked'));
  assert.equal(readFileSync(path.join(workspace, '.flowqa', 'runs', '.gitignore'), 'utf8'), '*\n');
});

test('missing configured model blocks only agent cases while preparing deterministic execution', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-engine-'));
  const mixed: Suite = {
    ...suite('normal'),
    cases: [
      { id: 'C1', title: 'normal', requirementIds: ['R1'], preconditions: [], questions: [], steps: [{ type: 'assertUrl', expected: 'http://127.0.0.1:1/' }] },
      { id: 'C2', title: 'agent', requirementIds: ['R1'], preconditions: [], questions: [], steps: [{ type: 'assertAgent', instruction: 'See heading' }] },
    ],
  };
  const abort = new AbortController();
  abort.abort();
  const result = await runSuite({ workspace, suite: mixed, config, targetName: 'local', signal: abort.signal });
  assert.equal(result.report.status, 'interrupted');
  assert.equal(result.report.cases[0]?.status, 'error');
  assert.equal(result.report.cases[1]?.status, 'blocked');
  const generated = readFileSync(path.join(result.runDir, 'suite.e2e.ts'), 'utf8');
  assert.match(generated, /test\.skip\("\[C2\] agent"/);
  assert.match(generated, /test\("\[C1\] normal"/);
});

test('collection/process failure still emits an error report and never marks the case passed', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-engine-'));
  // flow-qa permits an 8 KiB title, while e2e rejects a title over 512 UTF-8 bytes during collection.
  const result = await runSuite({ workspace, suite: suite('X'.repeat(513), false), config, targetName: 'local' });
  assert.equal(result.report.status, 'error');
  assert.equal(result.report.cases[0]?.status, 'error');
  assert.ok(result.report.errors.length > 0);
  assert.ok(readFileSync(path.join(result.runDir, 'qa-report.json'), 'utf8').includes('"status": "error"'));
});

test('direct runSuite rejects a stale source before launching e2e and still writes the report', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-engine-'));
  writeFileSync(path.join(workspace, 'flow.md'), 'changed');
  const stale: Suite = { ...suite('question'), source: { file: 'flow.md', sha256: '0'.repeat(64) } };
  const result = await runSuite({ workspace, suite: stale, config, targetName: 'local' });
  assert.equal(result.report.status, 'error');
  assert.match(result.report.errors.join(' '), /STALE_SUITE/);
  assert.ok(readFileSync(path.join(result.runDir, 'qa-report.json'), 'utf8').includes('STALE_SUITE'));
});
