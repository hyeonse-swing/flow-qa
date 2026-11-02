import assert from 'node:assert/strict';
import test from 'node:test';
import { compareReports, ComparisonError, comparisonCategories, renderComparisonMarkdown } from '../src/run-comparison.ts';
import type { QACaseStatus, QAReport } from '../src/report.ts';

const statuses: QACaseStatus[] = ['passed', 'failed', 'flaky', 'blocked', 'skipped', 'error'];

function report(runId: string, status: QACaseStatus = 'passed'): QAReport {
  return {
    schemaVersion: 'flow-qa/report-1', runId, suiteId: 'suite-a', suiteHash: 'a'.repeat(64),
    target: { name: 'local', url: 'http://127.0.0.1:3000' },
    startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:01:00.000Z', status: 'passed',
    cases: [{ id: 'TC-1', title: 'Example', status, expected: ['It works'], attempts: [], reason: 'observed' }],
    errors: [],
  };
}

function rejection(work: () => unknown, status: 400 | 409, message: RegExp): void {
  assert.throws(work, (error: unknown) => error instanceof ComparisonError && error.status === status && message.test(error.message));
}

test('every terminal case-status pair has exactly the observed transition category', () => {
  for (const before of statuses) for (const after of statuses) {
    const comparison = compareReports(report('baseline', before), report('current', after));
    const expected = before === after ? 'unchanged'
      : before === 'passed' && after === 'failed' ? 'newly-failed'
      : before === 'failed' && after === 'passed' ? 'now-passed' : 'changed';
    assert.equal(comparison.cases[0]?.category, expected, `${before} -> ${after}`);
    assert.equal(comparison.counts[expected], 1, `${before} -> ${after}`);
    assert.equal(Object.values(comparison.counts).reduce((sum, count) => sum + count, 0), 1);
  }
});

test('added and missing IDs are sorted, counted, and contain only safe case summaries', () => {
  const baseline = report('baseline');
  const current = report('current');
  baseline.cases.push({ id: 'Z', title: 'Removed', status: 'failed', expected: [], attempts: [] });
  current.cases.push({ id: 'A', title: 'Added', status: 'failed', expected: [], attempts: [] });
  baseline.cases[0]!.attempts.push({ index: 0, status: 'passed', startedAt: '', durationMs: 1, secondaryErrors: [], steps: [], artifacts: [{ kind: 'log', redaction: 'complete', path: 'raw/artifacts/private.txt' }] });
  const comparison = compareReports(baseline, current);
  assert.deepEqual(comparison.cases.map((item) => [item.id, item.category]), [['A', 'added'], ['TC-1', 'unchanged'], ['Z', 'missing']]);
  assert.equal(comparison.cases[0]?.baseline, null);
  assert.equal(comparison.cases[2]?.current, null);
  assert.deepEqual(comparisonCategories.map((key) => comparison.counts[key]), [0, 0, 0, 1, 1, 1]);
  assert.equal(JSON.stringify(comparison).includes('private.txt'), false);
  assert.equal(JSON.stringify(comparison).includes('attempts'), false);
});

test('suite, order, and incomplete-run warnings have stable order and do not reject different hashes', () => {
  const baseline = report('baseline');
  baseline.status = 'interrupted';
  const current = report('current');
  current.suiteHash = 'b'.repeat(64);
  current.startedAt = '2026-09-30T23:59:59.000Z';
  current.status = 'error';
  const comparison = compareReports(baseline, current);
  assert.deepEqual(comparison.warnings, ['suite-changed', 'reverse-order', 'incomplete-run']);
  assert.match(renderComparisonMarkdown(comparison), /Steps or expectations may differ.*do not prove a regression or fix/);
  assert.match(renderComparisonMarkdown(comparison, 'ko'), /단계나 기대 결과가 다를 수 있습니다.*회귀나 수정이 입증되지는 않습니다/);
});

test('mobile comparisons match recorded app/device selectors but warn that physical identity is unverified', () => {
  const baseline = report('baseline');
  const current = report('current');
  baseline.target = { name: 'phone', kind: 'mobile', platform: 'ios', bundleId: 'com.example.app', device: 'shared-name' };
  current.target = { ...baseline.target, name: 'renamed phone' };
  const comparison = compareReports(baseline, current);
  assert.deepEqual(comparison.warnings, ['mobile-identity-unverified']);
  assert.equal(comparison.current.target.name, 'renamed phone');
  assert.match(renderComparisonMarkdown(comparison), /do not verify that both runs used the same physical device/);
  assert.match(renderComparisonMarkdown(comparison, 'ko'), /같은 실제 기기에서 진행됐는지는.*확인할 수 없습니다/);
  assert.deepEqual(compareReports({ ...baseline, status: 'error' }, { ...current, suiteHash: 'b'.repeat(64), startedAt: '2026-09-30T00:00:00.000Z' }).warnings,
    ['suite-changed', 'reverse-order', 'incomplete-run', 'mobile-identity-unverified']);
  const selector = baseline.target;
  if (selector.kind !== 'mobile') throw new Error('Invalid test setup');
  rejection(() => compareReports(baseline, { ...current, target: { ...selector, bundleId: 'com.example.other' } }), 409, /same target/);
  rejection(() => compareReports(baseline, { ...current, target: { ...selector, platform: 'android' as const } }), 409, /same target/);
  rejection(() => compareReports(baseline, { ...current, target: { ...selector, device: 'another-name' } }), 409, /same target/);
});

test('comparison gates same run, different suite/target, empty hashes, and duplicate or empty IDs', () => {
  const baseline = report('baseline');
  const current = report('current');
  rejection(() => compareReports(baseline, { ...current, runId: baseline.runId }), 400, /different runs/);
  rejection(() => compareReports(baseline, { ...current, suiteId: 'suite-b' }), 409, /same suite/);
  rejection(() => compareReports(baseline, { ...current, target: { name: 'other', url: 'https://other.example' } }), 409, /same target/);
  assert.equal(compareReports(baseline, { ...current, target: { name: 'renamed', url: baseline.target.kind === 'mobile' ? '' : baseline.target.url } }).current.target.name, 'renamed');
  rejection(() => compareReports({ ...baseline, suiteHash: ' ' }, current), 409, /suite hash/);
  rejection(() => compareReports(baseline, { ...current, suiteHash: '' }), 409, /suite hash/);
  rejection(() => compareReports({ ...baseline, cases: [...baseline.cases, baseline.cases[0]!] }, current), 409, /case IDs/);
  rejection(() => compareReports(baseline, { ...current, cases: [{ ...current.cases[0]!, id: ' \t' }] }), 409, /case IDs/);
});

test('comparison is deterministic, does not mutate reports, and does not retain mutable inputs', () => {
  const baseline = report('baseline');
  const current = report('current');
  baseline.cases.unshift({ id: 'Z', title: 'First input', status: 'failed', expected: [], attempts: [] });
  current.cases.unshift({ id: 'A', title: 'Second input', status: 'passed', expected: [], attempts: [] });
  const before = JSON.stringify([baseline, current]);
  const first = compareReports(baseline, current);
  const second = compareReports(baseline, current);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify([baseline, current]), before);
  first.baseline.target.name = 'changed in result';
  first.cases.find((item) => item.id === 'TC-1')!.baseline!.expected.push('changed in result');
  assert.equal(JSON.stringify([baseline, current]), before);
});

test('Markdown escapes hostile IDs, target metadata, titles, expectations, and reasons', () => {
  const baseline = report('baseline');
  const current = report('current');
  baseline.target = { name: 'local <img src=x onerror=alert(1)>', url: 'https://example.test/[click](javascript:alert(1))' };
  current.target = { ...baseline.target, name: 'renamed' };
  baseline.cases[0]!.id = 'TC-1\n```\n# injected';
  current.cases[0]!.id = baseline.cases[0]!.id;
  current.cases[0]!.title = '<script>alert(1)</script> [click](javascript:alert(1))';
  current.cases[0]!.expected = ['line 1\n## injected', '`code` | https://evil.example/path', 'line\u2028break'];
  current.cases[0]!.reason = '<a href="javascript:alert(1)">run</a>';
  const comparison = compareReports(baseline, current);
  const markdown = renderComparisonMarkdown(comparison);
  assert.ok(markdown.includes('TC-1'));
  assert.ok(markdown.includes('\\`\\`\\`'));
  assert.ok(markdown.includes('\\\\n'));
  assert.ok(markdown.includes('\\\\u2028'));
  assert.match(markdown, /&lt;script&gt;/);
  assert.ok(markdown.includes('URL hidden'));
  assert.doesNotMatch(markdown, /\n# injected|\n## injected|<script|<img|<a href|\]\(javascript:/);
  assert.doesNotMatch(markdown, /```\n# injected/);
  assert.match(markdown, /newly-failed: 0/);
});

test('Markdown redacts web targets, credentialed URLs, and links while JSON retains report metadata', () => {
  const baseline = report('baseline');
  const current = report('current');
  baseline.target = { name: 'local https://user:secret@example.test/path?token=123', url: 'https://user:secret@example.test/path?token=123' };
  current.target = { ...baseline.target, name: 'renamed' };
  baseline.cases[0]!.title = 'Open https://user:secret@example.test/path?token=123';
  current.cases[0]!.expected = ['[view secret](https://user:secret@example.test/path?token=123)'];
  current.cases[0]!.reason = 'file:///private/token.txt';
  const comparison = compareReports(baseline, current);
  const markdown = renderComparisonMarkdown(comparison);
  const korean = renderComparisonMarkdown(comparison, 'ko');
  assert.ok(markdown.includes('URL hidden'));
  assert.ok(markdown.includes('link hidden'));
  assert.ok(korean.includes('URL 숨김') || korean.includes('링크 숨김'));
  assert.doesNotMatch(markdown, /user:secret|token=123|example\.test|file:\/\/\/private/);
  assert.doesNotMatch(korean, /user:secret|token=123|example\.test|file:\/\/\/private/);
  assert.match(JSON.stringify(comparison), /user:secret@example\.test/);
});
