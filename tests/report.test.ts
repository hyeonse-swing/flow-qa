import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeReport1, renderMarkdown, stoppedReport, type ReportContext } from '../src/report.ts';
import type { Suite } from '../src/schema.ts';

const suite: Suite = {
  schemaVersion: 'flow-qa/suite-1', id: 'checkout', title: 'Checkout',
  requirements: [{ id: 'R1', text: 'Checkout works' }],
  cases: [
    { id: 'A', title: 'first', requirementIds: ['R1'], preconditions: [], questions: [], steps: [{ type: 'assertUrl', expected: 'http://localhost:3000/' }] },
    { id: 'B', title: 'retry', requirementIds: ['R1'], preconditions: [], questions: [], steps: [{ type: 'assertUrl', expected: 'http://localhost:3000/' }] },
    { id: 'C', title: 'question', requirementIds: ['R1'], preconditions: [], questions: ['Which account?'], steps: [{ type: 'open', path: '/' }] },
  ],
};

const at = '2026-10-02T00:00:00.000Z';
function attempt(index: number, status: string, artifacts: unknown[] = []) {
  return { index, status, startedAt: at, durationMs: 200, error: status === 'failed' ? { code: 'ASSERTION_FAILED', message: 'observed old text' } : undefined,
    secondaryErrors: [], steps: [{ api: 'expect.toHaveURL', label: 'URL check', status: status === 'passed' ? 'passed' : 'failed' }], artifacts };
}
function result(id: string, status: string, attempts: unknown[]) {
  return { titlePath: [`[${id}] ${suite.cases.find((item) => item.id === id)!.title}`], file: 'suite.e2e.ts', targetId: 'local', kind: 'test', selected: true, status, attempts,
    ...(status === 'skipped' ? { skip: { cause: 'explicit', reason: 'question unresolved' } } : {}) };
}
function raw(results: unknown[], status = 'failed') {
  return { schemaVersion: 'report-1', run: { id: '0192f3a0-0000-7000-8000-000000000000', specVersion: '0.1', runner: { name: 'e2e', version: '0.15.1' },
    status, exitCode: status === 'passed' ? 0 : 1, startedAt: at, finishedAt: at,
    project: { id: 'checkout', configDigest: 'a'.repeat(64) }, targets: [{ id: 'local' }], results, errors: [], summary: {},
    usage: { modelTokens: 43, modelCachedTokens: 11, estimatedCostUsd: 0.002 } } };
}
function context(rawDir: string): ReportContext {
  return { suite, runId: 'run-1', suiteHash: 'a'.repeat(64), target: { name: 'local', url: 'http://localhost:3000/private?token=secret' },
    startedAt: at, finishedAt: at, rawDir, testFile: path.join(path.dirname(rawDir), 'suite.e2e.ts'), blockedReasons: new Map([['C', 'Unresolved question']]) };
}

test('retains failed and flaky attempts, blocked questions, usage, and only safe local evidence links', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-report-'));
  const rawDir = path.join(root, 'raw');
  mkdirSync(path.join(rawDir, 'artifacts'), { recursive: true });
  writeFileSync(path.join(rawDir, 'artifacts', 'good.png'), 'png');
  const artifacts = [
    { kind: 'screenshot', redaction: 'complete', path: 'good.png' },
    { kind: 'trace', redaction: 'incomplete', path: 'good.png' },
    { kind: 'screenshot', redaction: 'complete', path: '../outside.png' },
    { kind: 'screenshot', redaction: 'complete', path: 'https://evil.example/a.png' },
  ];
  const report = normalizeReport1(raw([
    result('A', 'failed', [attempt(0, 'failed', artifacts)]),
    result('B', 'flaky', [attempt(0, 'failed'), attempt(1, 'passed')]),
    result('C', 'skipped', []),
  ]), context(rawDir));
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.cases.map((item) => item.status), ['failed', 'flaky', 'blocked']);
  assert.deepEqual(report.cases[1]?.attempts.map((item) => item.status), ['failed', 'passed']);
  assert.equal(report.usage?.modelTokens, 43);
  assert.equal(report.usage?.estimatedCostUsd, 0.002);
  const markdown = renderMarkdown(report);
  assert.match(markdown, /raw\/artifacts\/good.png/);
  assert.doesNotMatch(markdown, /outside\.png|evil\.example|token=secret/);
  assert.equal(report.cases[0]?.attempts[0]?.artifacts.filter((item) => item.path).length, 1);
});

test('missing case cannot pass and unsupported, mismatched, or malformed statuses fail closed', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-report-'));
  const base = raw([result('A', 'passed', [attempt(0, 'passed')]), result('C', 'skipped', [])], 'passed');
  const missing = normalizeReport1(base, context(path.join(root, 'raw')));
  assert.equal(missing.status, 'error');
  assert.equal(missing.cases[1]?.status, 'error');
  assert.throws(() => normalizeReport1({ ...base, schemaVersion: 'report-2' }, context(root)), /version/);
  const badStatus = structuredClone(base);
  badStatus.run.results[0] = { ...(badStatus.run.results[0] as Record<string, unknown>), status: 'unknown' };
  assert.throws(() => normalizeReport1(badStatus, context(root)), /status/);
  const wrongFile = structuredClone(base);
  wrongFile.run.results[0] = { ...(wrongFile.run.results[0] as Record<string, unknown>), file: 'old.e2e.ts' };
  assert.throws(() => normalizeReport1(wrongFile, context(root)), /does not match/);
  const wrongProject = structuredClone(base);
  wrongProject.run.project.id = 'other';
  assert.throws(() => normalizeReport1(wrongProject, context(root)), /project/);
});

test('renders untrusted text as text, never as links, HTML, or remote URLs', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-report-'));
  const report = normalizeReport1(raw([result('A', 'failed', [attempt(0, 'failed')]), result('B', 'passed', [attempt(0, 'passed')]), result('C', 'skipped', [])]), context(root));
  report.cases[0]!.title = '<img src=x onerror=alert(1)> [click](https://evil.example/secret)';
  report.errors.push('failure at https://evil.example/private?token=123');
  report.cases[0]!.attempts[0]!.artifacts.push({ kind: 'screenshot', redaction: 'complete', path: 'raw/artifacts/../escape.png' });
  const markdown = renderMarkdown(report);
  assert.doesNotMatch(markdown, /<img|evil\.example|escape\.png|token=123/);
  assert.match(markdown, /&lt;img/);
  assert.match(markdown, /Error/);
});

test('classifies proven app transport failures as blocked and keeps product failures separate', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-report-'));
  const unreachable = attempt(0, 'failed');
  unreachable.error = { code: 'APP_UNREACHABLE', message: 'ERR_CONNECTION_REFUSED at http://127.0.0.1:3000/' };
  const closed = normalizeReport1(raw([
    result('A', 'failed', [unreachable]), result('B', 'passed', [attempt(0, 'passed')]), result('C', 'skipped', []),
  ], 'blocked'), context(root));
  assert.equal(closed.status, 'blocked');
  assert.equal(closed.cases[0]?.status, 'blocked');
  assert.match(closed.cases[0]?.reason ?? '', /ERR_CONNECTION_REFUSED/);
  assert.doesNotMatch(renderMarkdown(closed), /127\.0\.0\.1:3000/);

  const blockedWithFlaky = normalizeReport1(raw([
    result('A', 'failed', [unreachable]), result('B', 'flaky', [attempt(0, 'failed'), attempt(1, 'passed')]), result('C', 'skipped', []),
  ], 'blocked'), context(root));
  assert.equal(blockedWithFlaky.status, 'blocked');
  assert.equal(blockedWithFlaky.cases[1]?.status, 'flaky');

  const mixed = normalizeReport1(raw([
    result('A', 'failed', [unreachable]), result('B', 'failed', [attempt(0, 'failed')]), result('C', 'skipped', []),
  ]), context(root));
  assert.equal(mixed.status, 'failed');
  assert.deepEqual(mixed.cases.map((item) => item.status), ['blocked', 'failed', 'blocked']);
});

test('interruption keeps attempts already present in the current raw report', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-report-'));
  const partial = raw([result('A', 'failed', [attempt(0, 'failed')]), result('C', 'skipped', [])], 'interrupted');
  partial.run.exitCode = 130;
  const report = stoppedReport(partial, context(root), 'interrupted', 'User interrupt signal');
  assert.equal(report.status, 'interrupted');
  assert.equal(report.cases[0]?.attempts.length, 1);
  assert.equal(report.cases[1]?.status, 'error');
  assert.match(report.errors.join(' '), /User interrupt signal/);
});
