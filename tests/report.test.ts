import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileSuiteWithStepMap } from '../src/compiler.ts';
import { failureReport, isSavedReport, normalizeReport1, renderMarkdown, renderSavedMarkdown, stoppedReport, type ReportContext } from '../src/report.ts';
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

test('shows possible causes only when the run did not pass', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-report-'));
  const reportContext: ReportContext = { ...context(root), suite: { ...suite, cases: [suite.cases[0]!] }, blockedReasons: new Map() };
  const passed = normalizeReport1(raw([result('A', 'passed', [attempt(0, 'passed')])], 'passed'), reportContext);
  const failed = normalizeReport1(raw([result('A', 'failed', [attempt(0, 'failed')])]), reportContext);

  assert.equal(passed.status, 'passed');
  assert.doesNotMatch(renderMarkdown(passed), /Possible causes|observed evidence alone/);
  assert.doesNotMatch(renderMarkdown(passed, 'ko'), /가능한 원인|실패의 원인은/);

  assert.equal(failed.status, 'failed');
  assert.match(renderMarkdown(failed), /## Possible causes\n\nThe observed evidence alone does not establish the cause/);
  assert.match(renderMarkdown(failed, 'ko'), /## 가능한 원인\n\n실패의 원인은/);
  assert.match(renderMarkdown(failureReport(reportContext, 'error', 'No raw report')), /## Possible causes/);
});

test('saved reports validate optional authored step links and keep old records readable', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-report-'));
  const reportContext: ReportContext = { ...context(root), runId: '0192f3a0-0000-7000-8000-000000000001',
    suite: { ...suite, cases: [suite.cases[0]!] }, blockedReasons: new Map() };
  const report = normalizeReport1(raw([result('A', 'failed', [attempt(0, 'failed')])]), reportContext);
  assert.equal(isSavedReport(report), true);
  const linked = structuredClone(report);
  linked.cases[0]!.attempts[0]!.steps[0]!.sourceStepIndex = 0;
  assert.equal(isSavedReport(linked), true);
  linked.cases[0]!.attempts[0]!.steps[0]!.sourceSetup = true;
  assert.equal(isSavedReport(linked), false);
  delete linked.cases[0]!.attempts[0]!.steps[0]!.sourceSetup;
  linked.cases[0]!.attempts[0]!.steps[0]!.sourceStepIndex = 1;
  assert.equal(isSavedReport(linked), false);
  linked.cases[0]!.attempts[0]!.steps[0]!.sourceStepIndex = 0;
  linked.cases[0]!.attempts[0]!.steps.push({ api: 'expect.toHaveURL', label: 'duplicate', status: 'passed', sourceStepIndex: 0 });
  assert.equal(isSavedReport(linked), false);
  delete report.cases[0]!.definedSteps;
  assert.equal(isSavedReport(report), true);
});

test('normalization links only exact generated source lines and drops duplicate links', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-report-'));
  const oneCase = { ...suite, cases: [suite.cases[0]!] };
  const stepMap = compileSuiteWithStepMap(oneCase).stepMap;
  const locations = stepMap.cases.A!;
  const reportContext: ReportContext = { ...context(root), suite: oneCase, stepMap, blockedReasons: new Map() };
  const source = (line: number, file = 'suite.e2e.ts', column = 3) => ({ file, line, column });
  const engineStep = (status: 'passed' | 'failed', location: ReturnType<typeof source>) =>
    ({ api: 'expect.toHaveURL', label: 'same label', status, source: location });
  const record = (steps: unknown[]) => normalizeReport1(raw([result('A', 'failed', [{ ...attempt(0, 'failed'), steps }])]), reportContext);
  const setup = engineStep('passed', source(locations.setupLines[0]!));
  const authored = engineStep('failed', source(locations.stepLines[0]![0]!));
  const linked = record([setup, authored]);
  assert.equal(linked.cases[0]!.attempts[0]!.steps[0]!.sourceSetup, true);
  assert.equal(linked.cases[0]!.attempts[0]!.steps[1]!.sourceStepIndex, 0);
  const duplicate = record([setup, authored, authored]);
  assert.equal(duplicate.cases[0]!.attempts[0]!.steps[1]!.sourceStepIndex, undefined);
  assert.equal(duplicate.cases[0]!.attempts[0]!.steps[2]!.sourceStepIndex, undefined);
  assert.equal(isSavedReport({ ...duplicate, runId: '0192f3a0-0000-7000-8000-000000000001' }), true);
  const unknown = record([setup, engineStep('failed', source(locations.stepLines[0]![0]!, 'other.e2e.ts'))]);
  assert.equal(unknown.cases[0]!.attempts[0]!.steps[1]!.sourceStepIndex, undefined);
  const invalidColumn = record([setup, engineStep('failed', source(locations.stepLines[0]![0]!, 'suite.e2e.ts', 0))]);
  assert.equal(invalidColumn.cases[0]!.attempts[0]!.steps[1]!.sourceStepIndex, undefined);
});

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
  assert.match(markdown, /URL available in the local JSON report/);
});

test('mobile target identity survives normalized and failure reports without a fabricated URL', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-report-'));
  const mobileContext: ReportContext = {
    ...context(root),
    target: { name: 'local', kind: 'mobile', platform: 'ios', bundleId: 'kr.example.checkout', device: 'iPhone 17' },
  };
  const normalized = normalizeReport1(raw([
    result('A', 'failed', [attempt(0, 'failed')]),
    result('B', 'passed', [attempt(0, 'passed')]),
    result('C', 'skipped', []),
  ]), mobileContext);
  assert.deepEqual(normalized.target, mobileContext.target);
  assert.equal(normalized.cases[0]?.status, 'failed');
  const markdown = renderMarkdown(normalized);
  assert.ok(markdown.includes('kr\\.example\\.checkout'));
  assert.match(markdown, /iPhone 17/);
  assert.match(markdown, /ios/i);
  assert.doesNotMatch(markdown, /URL available in the local JSON report|https?:\/\//);

  const failure = failureReport(mobileContext, 'blocked', 'Device unavailable');
  assert.deepEqual(failure.target, mobileContext.target);
  assert.equal(failure.status, 'blocked');
  assert.ok(renderMarkdown(failure).includes('kr\\.example\\.checkout'));
  assert.match(renderMarkdown(failure), /iPhone 17/);
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

test('result status agrees with the complete retry history', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-report-'));
  const reportContext: ReportContext = { ...context(root), suite: { ...suite, cases: [suite.cases[0]!] }, blockedReasons: new Map() };
  const normalize = (status: string, attempts: unknown[], runStatus = 'failed') =>
    normalizeReport1(raw([result('A', status, attempts)], runStatus), reportContext);

  const firstPass = normalize('passed', [attempt(0, 'passed')], 'passed');
  assert.equal(firstPass.status, 'passed');
  assert.equal(firstPass.cases[0]?.status, 'passed');
  assert.match(renderMarkdown(firstPass), /passed/);
  assert.match(renderMarkdown(firstPass, 'ko'), /통과/);

  const flaky = normalize('flaky', [attempt(0, 'failed'), attempt(1, 'passed')]);
  assert.equal(flaky.status, 'failed');
  assert.equal(flaky.cases[0]?.status, 'flaky');
  assert.deepEqual(flaky.cases[0]?.attempts.map((item) => item.status), ['failed', 'passed']);
  assert.equal(normalize('flaky', [attempt(0, 'timed-out'), attempt(1, 'passed')]).cases[0]?.status, 'flaky');

  const dynamicSkip = normalize('skipped', [attempt(0, 'skipped')], 'blocked');
  assert.equal(dynamicSkip.cases[0]?.status, 'skipped');
  assert.equal(dynamicSkip.cases[0]?.attempts[0]?.status, 'skipped');

  assert.throws(() => normalize('passed', [attempt(0, 'failed'), attempt(1, 'passed')], 'passed'), /Passed status and attempts disagree/);
  assert.throws(() => normalize('passed', [attempt(1, 'passed')], 'passed'), /Passed status and attempts disagree/);
  assert.throws(() => normalize('flaky', [attempt(0, 'passed'), attempt(1, 'failed'), attempt(2, 'passed')]), /Flaky status and attempts disagree/);
  assert.throws(() => normalize('flaky', [attempt(0, 'skipped'), attempt(1, 'passed')]), /Flaky status and attempts disagree/);
  assert.throws(() => normalize('flaky', [attempt(0, 'failed'), attempt(2, 'passed')]), /Flaky status and attempts disagree/);
  for (const status of ['failed', 'timed-out']) {
    assert.throws(() => normalize(status, [attempt(0, 'passed')]), /status and attempts disagree/);
  }
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

test('partial scope survives normalized, stopped, and failure reports without unselected cases', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-report-'));
  const selectedContext: ReportContext = { ...context(root), selection: { caseIds: ['A'], totalCases: 3 }, blockedReasons: new Map() };
  const selectedRaw = raw([result('A', 'passed', [attempt(0, 'passed')])], 'passed');
  const normalized = normalizeReport1(selectedRaw, selectedContext);
  assert.equal(normalized.status, 'passed');
  assert.deepEqual(normalized.cases.map((item) => item.id), ['A']);
  assert.deepEqual(normalized.selection, selectedContext.selection);
  assert.match(renderMarkdown(normalized), /Selected 1 \/ 3 cases; full suite not evaluated/);
  assert.match(renderMarkdown(normalized, 'ko'), /선택 1 \/ 전체 3개 케이스; 전체 케이스 모음은 평가하지 않았습니다/);

  const stopped = stoppedReport(selectedRaw, selectedContext, 'interrupted', 'Stopped');
  assert.equal(stopped.status, 'interrupted');
  assert.deepEqual(stopped.cases.map((item) => item.id), ['A']);
  assert.deepEqual(stopped.selection, selectedContext.selection);

  const failed = failureReport(selectedContext, 'error', 'No raw report');
  assert.deepEqual(failed.cases.map((item) => item.id), ['A']);
  assert.deepEqual(failed.selection, selectedContext.selection);
  assert.match(renderMarkdown(failed), /full suite not evaluated/);
  assert.throws(() => normalizeReport1(raw([result('B', 'passed', [attempt(0, 'passed')])], 'passed'), selectedContext), /does not match/);
});

test('saved reader keeps valid failed, blocked, mobile and partial reports with evidence', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-saved-report-'));
  const rawDir = path.join(root, 'raw');
  mkdirSync(path.join(rawDir, 'artifacts'), { recursive: true });
  writeFileSync(path.join(rawDir, 'artifacts', 'screen.png'), 'png');
  const selected: ReportContext = { ...context(rawDir), runId: '666ecb72-0b3d-41d2-8cc8-a13917b23226',
    target: { name: 'local', kind: 'mobile', platform: 'ios', bundleId: 'kr.example.checkout', device: 'iPhone 17' },
    selection: { caseIds: ['A', 'B'], totalCases: 3 }, blockedReasons: new Map() };
  const failed = normalizeReport1(raw([
    result('A', 'failed', [attempt(0, 'failed', [{ kind: 'screenshot', redaction: 'complete', path: 'screen.png' }])]),
    result('B', 'passed', [attempt(0, 'passed')]),
  ]), selected);
  assert.equal(isSavedReport(failed), true);
  const markdown = renderSavedMarkdown(failed, 'legacy snapshot', 'ko');
  assert.match(markdown, /QA 결과|가능한 원인|선택 2 \/ 전체 3개|raw\/artifacts\/screen\.png|iPhone 17/);
  assert.doesNotMatch(markdown, /legacy snapshot/);
  const blocked = failureReport(selected, 'blocked', 'Device unavailable');
  assert.equal(isSavedReport(blocked), true);
  assert.match(renderSavedMarkdown(blocked, 'legacy snapshot', 'en'), /Possible causes/);
});
