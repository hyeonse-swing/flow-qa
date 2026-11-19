import assert from 'node:assert/strict';
import test from 'node:test';
import { compareCaseSteps } from '../src/step-comparison.ts';
import type { QAAttempt, QACase } from '../src/report.ts';

const definedSteps: QACase['definedSteps'] = [
  { type: 'assertText' }, { type: 'open' }, { type: 'assertText' }, { type: 'assertVisible' },
];

function attempt(index: number, status: QAAttempt['status'], observed: (string | undefined)[]): QAAttempt {
  return {
    index, status, startedAt: '2026-11-19T00:00:00.000Z', durationMs: 10, secondaryErrors: [], artifacts: [],
    steps: [
      { api: 'app.open', label: 'setup', status: 'passed', sourceSetup: true },
      ...observed.flatMap((state, sourceStepIndex) => state
        ? [{ api: 'test', label: 'observed', status: state, sourceStepIndex }]
        : []),
    ],
  };
}

function item(attempts: QAAttempt[]): QACase {
  return { id: 'CASE1', title: 'Repeated assertion', status: 'failed', expected: [], definedSteps, attempts };
}

test('last attempts distinguish duplicate authored assertions and mark post-failure steps unrun', () => {
  const before = item([attempt(0, 'failed', ['passed', 'passed', 'failed']),
    attempt(1, 'passed', ['passed', 'passed', 'passed', 'passed'])]);
  const after = item([attempt(0, 'failed', ['passed', 'passed', 'failed'])]);
  const result = compareCaseSteps(before, after, true);
  assert.equal(result.availability, 'compared');
  assert.deepEqual(result.baselineAttempt, { index: 2, total: 2, status: 'passed' });
  assert.deepEqual(result.currentAttempt, { index: 1, total: 1, status: 'failed' });
  assert.equal(result.lastCommonPassedStepIndex, 1);
  assert.equal(result.firstDifferenceStepIndex, 2);
  assert.deepEqual(result.steps?.map((step) => [step.index, step.baseline, step.current]), [
    [0, 'passed', 'passed'], [1, 'passed', 'passed'], [2, 'passed', 'failed'], [3, 'passed', 'not-run'],
  ]);
});

test('matching failures have a common passing prefix and no differing observed result', () => {
  const same = item([attempt(0, 'failed', ['passed', 'failed'])]);
  const result = compareCaseSteps(same, same, true);
  assert.equal(result.availability, 'compared');
  assert.equal(result.lastCommonPassedStepIndex, 0);
  assert.equal(result.firstDifferenceStepIndex, undefined);
  assert.equal(result.steps?.[2]?.current, 'not-run');
});

test('old records, changed definitions, missing attempts, and mismatched suites do not claim a first difference', () => {
  const complete = item([attempt(0, 'passed', ['passed', 'passed', 'passed', 'passed'])]);
  const old = { ...complete, definedSteps: undefined };
  assert.equal(compareCaseSteps(complete, old, true).reason, 'definition-unavailable');
  assert.equal(compareCaseSteps(complete, complete, false).reason, 'suite-changed');
  assert.equal(compareCaseSteps(complete, undefined, true).reason, 'case-absent');
  assert.equal(compareCaseSteps(complete, item([]), true).reason, 'attempt-unavailable');
  const changed = { ...complete, definedSteps: [{ type: 'open' as const }, ...definedSteps!.slice(1)] };
  assert.equal(compareCaseSteps(complete, changed, true).reason, 'definition-changed');
});

test('unknown, duplicated, out-of-order, and incomplete engine records stay unavailable', () => {
  const complete = item([attempt(0, 'passed', ['passed', 'passed', 'passed', 'passed'])]);
  const unknown = structuredClone(complete);
  delete unknown.attempts[0]!.steps[2]!.sourceStepIndex;
  assert.equal(compareCaseSteps(complete, unknown, true).reason, 'step-unlinked');
  const duplicated = structuredClone(complete);
  duplicated.attempts[0]!.steps.push({ api: 'test', label: 'extra', status: 'passed', sourceStepIndex: 3 });
  assert.equal(compareCaseSteps(complete, duplicated, true).reason, 'step-ambiguous');
  const partial = item([attempt(0, 'failed', ['passed', undefined, 'failed'])]);
  assert.equal(compareCaseSteps(complete, partial, true).reason, 'record-incomplete');
  const truncated = item([attempt(0, 'passed', ['passed', 'passed'])]);
  assert.equal(compareCaseSteps(complete, truncated, true).reason, 'record-incomplete');
  const setupFailure = structuredClone(complete);
  setupFailure.attempts[0]!.steps[0]!.status = 'failed';
  assert.equal(compareCaseSteps(complete, setupFailure, true).reason, 'setup-failed');
});
