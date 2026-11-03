import assert from 'node:assert/strict';
import test from 'node:test';
import { CaseSelectionError, isReportSelectionValid, selectCases } from '../src/case-selection.ts';
import { compileSuite } from '../src/compiler.ts';
import { suiteSchema, type Suite } from '../src/schema.ts';

const suite: Suite = {
  schemaVersion: 'flow-qa/suite-1', id: 'selection', title: 'Selection',
  requirements: [{ id: 'R1', text: 'First' }, { id: 'R2', text: 'Second' }, { id: 'R3', text: 'Third' }],
  cases: [
    { id: 'C1', title: 'First', requirementIds: ['R1'], preconditions: [], questions: [], steps: [{ type: 'assertUrl', expected: '/one' }] },
    { id: 'C2', title: 'Second', requirementIds: ['R2'], preconditions: [], questions: [], steps: [{ type: 'assertUrl', expected: '/two' }] },
    { id: 'C3', title: 'Third', requirementIds: ['R1', 'R3'], preconditions: [], questions: [], steps: [{ type: 'assertUrl', expected: '/three' }] },
  ],
};

test('explicit selection keeps suite order and only the requirements needed by selected cases', () => {
  const original = JSON.stringify(suite);
  const result = selectCases(suite, ['C3', 'C1']);
  assert.deepEqual(result.selection, { caseIds: ['C1', 'C3'], totalCases: 3 });
  assert.deepEqual(result.suite.cases.map((item) => item.id), ['C1', 'C3']);
  assert.deepEqual(result.suite.requirements.map((item) => item.id), ['R1', 'R3']);
  assert.deepEqual(suiteSchema.parse(result.suite), result.suite);
  assert.equal(JSON.stringify(suite), original);
  assert.notEqual(result.suite, suite);
  const source = compileSuite(result.suite);
  assert.match(source, /\[C1\].*First/);
  assert.match(source, /\[C3\].*Third/);
  assert.doesNotMatch(source, /\[C2\]|\/two/);
});

test('omitted and explicit-all selections normalize to the original complete suite', () => {
  assert.deepEqual(selectCases(suite), { suite });
  assert.equal(selectCases(suite).suite, suite);
  assert.deepEqual(selectCases(suite, ['C3', 'C1', 'C2']), { suite });
  assert.equal(selectCases(suite, ['C3', 'C1', 'C2']).suite, suite);
});

test('empty, duplicate and unknown requested IDs fail instead of silently expanding scope', () => {
  for (const ids of [[], ['C1', 'C1'], ['C1', 'unknown']]) {
    assert.throws(() => selectCases(suite, ids), CaseSelectionError);
  }
  assert.throws(() => selectCases(suite, []), /at least one/);
  assert.throws(() => selectCases(suite, ['C2', 'C2']), /Duplicate/);
  assert.throws(() => selectCases(suite, ['unknown']), /Unknown/);
});

test('report selection validator accepts legacy reports and only coherent partial metadata', () => {
  const cases = [{ id: 'C1' }, { id: 'C3' }];
  assert.equal(isReportSelectionValid(cases, undefined), true);
  assert.equal(isReportSelectionValid(cases, { caseIds: ['C3', 'C1'], totalCases: 3 }), true);
  for (const invalid of [
    null, [], {}, { caseIds: [], totalCases: 3 }, { caseIds: ['C1', 'C1'], totalCases: 3 },
    { caseIds: ['C1', 'C2'], totalCases: 3 }, { caseIds: ['C1', 'C3'], totalCases: 2 },
    { caseIds: ['C1', 'C3'], totalCases: 101 }, { caseIds: ['C1', 'C3'], totalCases: 2.5 },
    { caseIds: ['C1', 'C3'], totalCases: 3, extra: true },
  ]) assert.equal(isReportSelectionValid(cases, invalid), false, JSON.stringify(invalid));
  assert.equal(isReportSelectionValid([{ id: 'C1' }, { id: 'C1' }], undefined), false);
});
