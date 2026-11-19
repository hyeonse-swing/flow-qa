import { localized, type Locale } from './i18n.ts';
import { isReportSelectionValid, type RunSelection } from './case-selection.ts';
import type { QACase, QACaseStatus, QAReport, QAStatus } from './report.ts';
import { compareCaseSteps, type StepComparison, type StepComparisonReason } from './step-comparison.ts';
import { sameReportTarget, targetLabel, type ReportTarget } from './targets.ts';

export const comparisonCategories = ['newly-failed', 'now-passed', 'changed', 'unchanged', 'added', 'missing'] as const;
export type ComparisonCategory = (typeof comparisonCategories)[number];
export type ComparisonWarning = 'suite-changed' | 'partial-run' | 'selection-changed' | 'reverse-order' | 'incomplete-run' | 'mobile-identity-unverified';

export interface ComparisonRun {
  runId: string;
  suiteId: string;
  suiteHash: string;
  target: ReportTarget;
  startedAt: string;
  finishedAt: string;
  status: QAStatus;
  selection?: RunSelection;
}

export interface ComparisonCaseSnapshot {
  title: string;
  status: QACaseStatus;
  expected: string[];
  reason?: string;
}

export interface ComparisonCase {
  id: string;
  category: ComparisonCategory;
  baseline: ComparisonCaseSnapshot | null;
  current: ComparisonCaseSnapshot | null;
  stepComparison: StepComparison;
}

export interface RunComparison {
  schemaVersion: 'flow-qa/comparison-1';
  baseline: ComparisonRun;
  current: ComparisonRun;
  warnings: ComparisonWarning[];
  counts: Record<ComparisonCategory, number>;
  cases: ComparisonCase[];
}

export class ComparisonError extends Error {
  readonly status: 400 | 409;
  constructor(status: 400 | 409, message: string) { super(message); this.status = status; }
}

function validateCaseIds(report: QAReport): Map<string, QACase> {
  const cases = new Map<string, QACase>();
  for (const item of report.cases) {
    if (!item.id.trim() || cases.has(item.id)) {
      throw new ComparisonError(409, 'Both reports need unique, non-empty case IDs.');
    }
    cases.set(item.id, item);
  }
  return cases;
}

function runSummary(report: QAReport): ComparisonRun {
  return {
    runId: report.runId, suiteId: report.suiteId, suiteHash: report.suiteHash,
    target: { ...report.target }, startedAt: report.startedAt,
    finishedAt: report.finishedAt, status: report.status,
    ...(report.selection ? { selection: { caseIds: [...report.selection.caseIds], totalCases: report.selection.totalCases } } : {}),
  };
}

function caseSnapshot(item: QACase | undefined): ComparisonCaseSnapshot | null {
  if (!item) return null;
  return {
    title: item.title, status: item.status, expected: [...item.expected],
    ...(item.reason === undefined ? {} : { reason: item.reason }),
  };
}

function category(baseline: QACase | undefined, current: QACase | undefined): ComparisonCategory {
  if (!baseline) return 'added';
  if (!current) return 'missing';
  if (baseline.status === current.status) return 'unchanged';
  if (baseline.status === 'passed' && current.status === 'failed') return 'newly-failed';
  if (baseline.status === 'failed' && current.status === 'passed') return 'now-passed';
  return 'changed';
}

/** Keep final-status categories stable and add conservative authored-step evidence. */
export function compareReports(baseline: QAReport, current: QAReport): RunComparison {
  if (baseline.runId === current.runId) throw new ComparisonError(400, 'A comparison needs two different runs.');
  if (baseline.suiteId !== current.suiteId) throw new ComparisonError(409, 'Both reports must belong to the same suite.');
  if (!sameReportTarget(baseline.target, current.target)) {
    throw new ComparisonError(409, 'Both reports must use the same target.');
  }
  if (!baseline.suiteHash.trim() || !current.suiteHash.trim()) {
    throw new ComparisonError(409, 'Both reports need a non-empty suite hash.');
  }
  const before = validateCaseIds(baseline);
  const after = validateCaseIds(current);
  if (!isReportSelectionValid(baseline.cases, baseline.selection) || !isReportSelectionValid(current.cases, current.selection)) {
    throw new ComparisonError(409, 'The report selection does not match its recorded cases.');
  }
  const warnings: ComparisonWarning[] = [];
  if (baseline.suiteHash !== current.suiteHash) warnings.push('suite-changed');
  if (baseline.selection || current.selection) {
    warnings.push('partial-run');
    if (before.size !== after.size || [...before.keys()].some((id) => !after.has(id))) warnings.push('selection-changed');
  }
  if (Date.parse(current.startedAt) < Date.parse(baseline.startedAt)) warnings.push('reverse-order');
  if (baseline.status === 'interrupted' || baseline.status === 'error' || current.status === 'interrupted' || current.status === 'error') {
    warnings.push('incomplete-run');
  }
  if (baseline.target.kind === 'mobile') warnings.push('mobile-identity-unverified');
  const counts = Object.fromEntries(comparisonCategories.map((value) => [value, 0])) as Record<ComparisonCategory, number>;
  const cases = [...new Set([...before.keys(), ...after.keys()])].sort().map((id): ComparisonCase => {
    const baselineCase = before.get(id);
    const currentCase = after.get(id);
    const transition = category(baselineCase, currentCase);
    counts[transition]++;
    return { id, category: transition, baseline: caseSnapshot(baselineCase), current: caseSnapshot(currentCase),
      stepComparison: compareCaseSteps(baselineCase, currentCase, baseline.suiteHash === current.suiteHash) };
  });
  return { schemaVersion: 'flow-qa/comparison-1', baseline: runSummary(baseline), current: runSummary(current), warnings, counts, cases };
}

function safeInline(value: string, locale: Locale): string {
  return value.replace(/(?:https?:\/\/|file:\/\/)[^\s<>"'\])}]+/gi, localized(locale, '[URL hidden]', '[URL 숨김]'))
    .replace(/\[[^\]]*\]\([^)]*\)/g, localized(locale, '[link hidden]', '[링크 숨김]'))
    .replace(/[\x00-\x1f\x7f\u0085\u2028\u2029]/g, (character) => {
    if (character === '\n') return '\\n';
    if (character === '\r') return '\\r';
    if (character === '\t') return '\\t';
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
  }).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+.!|~:])/g, '\\$1');
}

export function renderComparisonMarkdown(comparison: RunComparison, locale: Locale = 'en'): string {
  const label = (english: string, korean: string) => localized(locale, english, korean);
  const safe = (value: string) => safeInline(value, locale);
  const run = (name: string, item: ComparisonRun) => [
    `## ${name}`,
    '',
    `- ${label('Run ID', '실행 ID')}: ${safe(item.runId)}`,
    `- ${label('Suite ID', '케이스 모음 ID')}: ${safe(item.suiteId)}`,
    `- ${label('Suite hash', '케이스 모음 해시')}: ${safe(item.suiteHash)}`,
    `- ${label('Target', '대상')}: ${safe(item.target.name)} ${item.target.kind === 'mobile'
      ? safe(targetLabel(item.target))
      : label('(URL available in the local JSON comparison)', '(주소는 로컬 JSON 비교 결과에서 확인)')}`,
    `- ${label('Started', '시작')}: ${safe(item.startedAt)}`,
    `- ${label('Finished', '종료')}: ${safe(item.finishedAt)}`,
    `- ${label('Status', '상태')}: ${safe(item.status)}`,
    ...(item.selection ? [`- ${label('Scope', '범위')}: ${label(
      `Selected ${item.selection.caseIds.length} / ${item.selection.totalCases} cases; full suite not evaluated.`,
      `선택 ${item.selection.caseIds.length} / 전체 ${item.selection.totalCases}개 케이스; 전체 케이스 모음은 평가하지 않았습니다.`,
    )}`] : []),
    '',
  ];
  const warningText: Record<ComparisonWarning, string> = {
    'suite-changed': label('Steps or expectations may differ because the suite changed; these outcomes do not prove a regression or fix.', '케이스 모음이 변경되어 단계나 기대 결과가 다를 수 있습니다. 이 결과만으로 회귀나 수정이 입증되지는 않습니다.'),
    'partial-run': label('At least one run evaluated only selected cases; the full suite was not evaluated.', '하나 이상의 실행에서 선택한 케이스만 평가했습니다. 전체 케이스 모음은 평가하지 않았습니다.'),
    'selection-changed': label('The runs selected different case sets; added or missing entries may reflect scope rather than a changed outcome.', '실행마다 선택한 케이스가 다릅니다. 추가 또는 누락 항목은 결과 변화가 아닌 실행 범위 차이일 수 있습니다.'),
    'reverse-order': label('The selected current run started before the baseline run.', '선택한 현재 실행이 기준 실행보다 먼저 시작됐습니다.'),
    'incomplete-run': label('At least one run ended with error or interruption; case results may be incomplete.', '하나 이상의 실행이 오류 또는 중단으로 끝나 케이스 결과가 불완전할 수 있습니다.'),
    'mobile-identity-unverified': label('The recorded app and device settings match, but these reports do not verify that both runs used the same physical device.', '기록된 앱과 기기 설정은 같지만, 두 실행이 같은 실제 기기에서 진행됐는지는 이 리포트로 확인할 수 없습니다.'),
  };
  const stepReasons: Record<StepComparisonReason, string> = {
    'suite-changed': label('Suite definitions differ.', '케이스 모음 정의가 다릅니다.'),
    'case-absent': label('The case is absent from one run.', '한쪽 실행에 케이스 기록이 없습니다.'),
    'definition-unavailable': label('Authored step definitions are unavailable.', '원본 단계 정의 기록이 없습니다.'),
    'definition-changed': label('Recorded step definitions differ.', '기록된 단계 정의가 다릅니다.'),
    'attempt-unavailable': label('An execution attempt is missing.', '실행 시도 기록이 없습니다.'),
    'step-unlinked': label('An engine step has no verified authored-step link.', '원본 단계와 연결할 수 없는 엔진 기록이 있습니다.'),
    'step-ambiguous': label('The step links are duplicated or out of order.', '단계 연결이 중복되거나 순서가 맞지 않습니다.'),
    'record-incomplete': label('The attempt lacks enough ordered step evidence.', '시도 기록에 순서대로 연결된 단계 근거가 부족합니다.'),
    'setup-failed': label('The generated setup step failed.', '생성된 준비 단계가 실패했습니다.'),
  };
  const lines = [
    `# ${label('QA run comparison', 'QA 실행 비교')}`,
    '',
    ...run(label('Baseline', '기준 실행'), comparison.baseline),
    ...run(label('Current', '현재 실행'), comparison.current),
    `## ${label('Transition counts', '상태 전이 개수')}`,
    '',
    ...comparisonCategories.map((category) => `- ${category}: ${comparison.counts[category]}`),
    '',
    `## ${label('Warnings', '주의 사항')}`,
    '',
    ...(comparison.warnings.length
      ? comparison.warnings.map((warning) => `- ${warning}: ${warningText[warning]}`)
      : [`- ${label('None', '없음')}`]),
    '',
    label('These categories describe observed status transitions only. They do not establish the cause of a failure or prove that a defect was fixed.', '이 분류는 관찰된 상태 전이만 나타냅니다. 실패 원인이나 결함 수정 여부를 입증하지 않습니다.'),
    '',
    `## ${label('Cases', '케이스')}`,
    '',
  ];
  for (const item of comparison.cases) {
    lines.push(`### ${safe(item.id)} — ${item.category}`, '');
    for (const [name, entry] of [[label('Baseline', '기준 실행'), item.baseline], [label('Current', '현재 실행'), item.current]] as const) {
      if (!entry) { lines.push(`- ${name}: ${label('Absent', '없음')}`); continue; }
      lines.push(`- ${name}: ${safe(entry.status)} · ${safe(entry.title)}`);
      lines.push(`  - ${label('Expected', '기대 결과')}: ${entry.expected.length ? entry.expected.map(safe).join('; ') : label('None', '없음')}`);
      if (entry.reason !== undefined) lines.push(`  - ${label('Reason', '실행 상태 근거')}: ${safe(entry.reason)}`);
    }
    const steps = item.stepComparison;
    for (const [name, attempt] of [[label('Baseline attempt', '기준 시도'), steps.baselineAttempt],
      [label('Current attempt', '현재 시도'), steps.currentAttempt]] as const) {
      if (attempt) lines.push(`- ${name}: ${attempt.index}/${attempt.total} · ${safe(attempt.status)}`);
    }
    if (steps.availability === 'unavailable') {
      lines.push(`- ${label('Step comparison unavailable', '단계 비교 불가')}: ${stepReasons[steps.reason ?? 'record-incomplete']}`);
    } else {
      lines.push(`- ${label('Generated setup calls', '생성된 준비 호출')}: ${steps.baselineSetupSteps ?? 0} → ${steps.currentSetupSteps ?? 0}`);
      lines.push(`- ${label('Last common passed step', '마지막 공통 성공 단계')}: ${steps.lastCommonPassedStepIndex === undefined ? label('None', '없음') : steps.lastCommonPassedStepIndex + 1}`);
      lines.push(`- ${label('First differing step', '첫 결과 차이 단계')}: ${steps.firstDifferenceStepIndex === undefined ? label('None', '없음') : steps.firstDifferenceStepIndex + 1}`);
      for (const step of steps.steps ?? []) {
        lines.push(`  - ${step.index + 1}. ${safe(step.type)}: ${safe(step.baseline)} → ${safe(step.current)}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
