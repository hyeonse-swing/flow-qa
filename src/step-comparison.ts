import type { QAAttempt, QACase } from './report.ts';
import type { Step } from './schema.ts';

export type StepComparisonReason = 'suite-changed' | 'case-absent' | 'definition-unavailable' |
  'definition-changed' | 'attempt-unavailable' | 'step-unlinked' | 'step-ambiguous' |
  'record-incomplete' | 'setup-failed';
export type ObservedStepStatus = 'passed' | 'failed' | 'blocked' | 'timed-out' | 'cancelled' | 'not-run';

export interface StepComparison {
  availability: 'compared' | 'unavailable';
  reason?: StepComparisonReason;
  baselineAttempt?: { index: number; total: number; status: QAAttempt['status'] };
  currentAttempt?: { index: number; total: number; status: QAAttempt['status'] };
  baselineSetupSteps?: number;
  currentSetupSteps?: number;
  lastCommonPassedStepIndex?: number;
  firstDifferenceStepIndex?: number;
  steps?: { index: number; type: Step['type']; baseline: ObservedStepStatus; current: ObservedStepStatus }[];
}

const authoredTypes = new Set<Step['type']>([
  'open', 'launchApp', 'back', 'swipe', 'act', 'click', 'fill',
  'assertVisible', 'assertText', 'assertUrl', 'assertAgent',
]);
const observedStatuses = new Set<ObservedStepStatus>(['passed', 'failed', 'blocked', 'timed-out', 'cancelled']);
const attemptStatuses = new Set<QAAttempt['status']>(['passed', 'failed', 'timed-out', 'interrupted', 'skipped']);

function finalAttempt(testCase: QACase | undefined): StepComparison['baselineAttempt'] {
  if (!testCase || !Array.isArray(testCase.attempts) || !testCase.attempts.length) return undefined;
  const index = testCase.attempts.length - 1;
  const attempt = testCase.attempts[index];
  if (!attempt || attempt.index !== index || !attemptStatuses.has(attempt.status)) return undefined;
  return { index: index + 1, total: testCase.attempts.length, status: attempt.status };
}

function observed(testCase: QACase, count: number): { steps: ObservedStepStatus[]; setup: number } | StepComparisonReason {
  const attempt = testCase.attempts.at(-1);
  if (!attempt || !Array.isArray(attempt.steps)) return 'attempt-unavailable';
  const steps: (ObservedStepStatus | undefined)[] = Array(count).fill(undefined);
  let setup = 0;
  let previousIndex = -1;
  let failedSetup = false;
  for (const record of attempt.steps) {
    if (!record || typeof record !== 'object' || !observedStatuses.has(record.status as ObservedStepStatus)) return 'record-incomplete';
    if (record.sourceSetup === true && record.sourceStepIndex === undefined) {
      setup++;
      failedSetup ||= record.status !== 'passed';
      continue;
    }
    const index = record.sourceStepIndex;
    if (index === undefined) return 'step-unlinked';
    if (!Number.isSafeInteger(index) || index < 0 || index >= count || index <= previousIndex || steps[index] !== undefined) return 'step-ambiguous';
    steps[index] = record.status as ObservedStepStatus;
    previousIndex = index;
  }
  if (failedSetup) return 'setup-failed';
  if (previousIndex < 0) return 'record-incomplete';
  if (steps.slice(0, previousIndex + 1).some((status) => status === undefined)) return 'record-incomplete';
  if (steps.slice(previousIndex + 1).some((status) => status !== undefined)) return 'record-incomplete';
  if (previousIndex < count - 1) {
    const last = steps[previousIndex];
    if (!['failed', 'blocked', 'timed-out', 'cancelled'].includes(last ?? '') ||
      !['failed', 'timed-out'].includes(attempt.status)) return 'record-incomplete';
    steps.fill('not-run', previousIndex + 1);
  }
  if (attempt.status === 'passed' && steps.some((status) => status !== 'passed')) return 'record-incomplete';
  return { steps: steps as ObservedStepStatus[], setup };
}

export function compareCaseSteps(baseline: QACase | undefined, current: QACase | undefined, sameSuite: boolean): StepComparison {
  const baselineAttempt = finalAttempt(baseline);
  const currentAttempt = finalAttempt(current);
  const attempts = {
    ...(baselineAttempt ? { baselineAttempt } : {}),
    ...(currentAttempt ? { currentAttempt } : {}),
  };
  const unavailable = (reason: StepComparisonReason): StepComparison => ({ availability: 'unavailable', reason, ...attempts });
  if (!baseline || !current) return unavailable('case-absent');
  if (!sameSuite) return unavailable('suite-changed');
  if (!Array.isArray(baseline.definedSteps) || !Array.isArray(current.definedSteps) ||
    baseline.definedSteps.length === 0 || baseline.definedSteps.length > 100 ||
    baseline.definedSteps.some((step) => !authoredTypes.has(step?.type)) ||
    current.definedSteps.some((step) => !authoredTypes.has(step?.type))) return unavailable('definition-unavailable');
  if (baseline.definedSteps.length !== current.definedSteps.length ||
    baseline.definedSteps.some((step, index) => step.type !== current.definedSteps?.[index]?.type)) return unavailable('definition-changed');
  if (!baselineAttempt || !currentAttempt) return unavailable('attempt-unavailable');
  const left = observed(baseline, baseline.definedSteps.length);
  const right = observed(current, baseline.definedSteps.length);
  if (typeof left === 'string') return unavailable(left);
  if (typeof right === 'string') return unavailable(right);
  const steps = baseline.definedSteps.map((step, index) => ({
    index, type: step.type, baseline: left.steps[index]!, current: right.steps[index]!,
  }));
  let lastCommonPassedStepIndex: number | undefined;
  let firstDifferenceStepIndex: number | undefined;
  for (const step of steps) {
    if (firstDifferenceStepIndex === undefined && step.baseline !== step.current) firstDifferenceStepIndex = step.index;
    if (lastCommonPassedStepIndex === step.index - 1 || (lastCommonPassedStepIndex === undefined && step.index === 0)) {
      if (step.baseline === 'passed' && step.current === 'passed') lastCommonPassedStepIndex = step.index;
    }
  }
  return {
    availability: 'compared', ...attempts,
    baselineSetupSteps: left.setup, currentSetupSteps: right.setup,
    ...(lastCommonPassedStepIndex === undefined ? {} : { lastCommonPassedStepIndex }),
    ...(firstDifferenceStepIndex === undefined ? {} : { firstDifferenceStepIndex }),
    steps,
  };
}
