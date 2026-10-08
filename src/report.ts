import { realpathSync } from 'node:fs';
import path from 'node:path';
import { expectedChecks } from './compiler.ts';
import { localized, localizeProductMessage, type Locale } from './i18n.ts';
import type { Suite } from './schema.ts';

export type QAStatus = 'passed' | 'failed' | 'blocked' | 'error' | 'interrupted';
export type QACaseStatus = 'passed' | 'failed' | 'flaky' | 'blocked' | 'skipped' | 'error';
export type QAAttemptStatus = 'passed' | 'failed' | 'timed-out' | 'interrupted' | 'skipped';

export interface QAError {
  code: string;
  message: string;
  category?: 'test' | 'configuration' | 'infrastructure' | 'internal' | 'interrupted';
}

export interface QAArtifact {
  kind: string;
  redaction: 'complete' | 'not-required' | 'incomplete';
  /** A local path relative to this run's qa-report.md, if it was safe to expose. */
  path?: string;
}

export interface QAAttempt {
  index: number;
  status: QAAttemptStatus;
  startedAt: string;
  durationMs: number;
  error?: QAError;
  secondaryErrors: QAError[];
  steps: {
    api: string;
    label: string;
    status: string;
    error?: QAError;
    model?: { provider: string; model: string; inputTokens: number; outputTokens: number; estimatedCostUsd?: number };
  }[];
  artifacts: QAArtifact[];
}

export interface QACase {
  id: string;
  title: string;
  status: QACaseStatus;
  expected: string[];
  attempts: QAAttempt[];
  reason?: string;
}

export interface QAReport {
  schemaVersion: 'flow-qa/report-1';
  runId: string;
  suiteId: string;
  suiteHash: string;
  target: { name: string; url: string };
  startedAt: string;
  finishedAt: string;
  status: QAStatus;
  cases: QACase[];
  errors: string[];
  usage?: { modelTokens: number; modelCachedTokens?: number; estimatedCostUsd?: number };
}

export interface ReportContext {
  suite: Suite;
  runId: string;
  suiteHash: string;
  target: { name: string; url: string };
  startedAt: string;
  finishedAt: string;
  rawDir: string;
  testFile: string;
  blockedReasons: ReadonlyMap<string, string>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid raw report field: ${label}.`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid raw report field: ${label}.`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid raw report field: ${label}.`);
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid raw report field: ${label}.`);
  return value;
}

function integer(value: unknown, label: string): number {
  const checked = number(value, label);
  if (!Number.isInteger(checked)) throw new Error(`Invalid raw report field: ${label}.`);
  return checked;
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new Error(`Unsupported raw report value: ${label}.`);
  return value as T;
}

function rawError(value: unknown): QAError {
  const item = object(value, 'error');
  return { code: string(item.code, 'error.code'), message: string(item.message, 'error.message'),
    ...(item.category === undefined ? {} : { category: oneOf(item.category, ['test', 'configuration', 'infrastructure', 'internal', 'interrupted'] as const, 'error.category') }) };
}

const attemptStatuses = ['passed', 'failed', 'timed-out', 'interrupted', 'skipped'] as const;
const resultStatuses = ['passed', 'flaky', 'failed', 'timed-out', 'interrupted', 'skipped'] as const;
const runStatuses = ['passed', 'failed', 'blocked', 'error', 'interrupted'] as const;
const redactionStatuses = ['complete', 'not-required', 'incomplete'] as const;
// e2e 0.15.1's documented blockedCategory codes. Only a final attempt carrying
// one of these codes proves that a failed/timed-out result was blocked.
const blockableCodes = new Set([
  'AUTH_CREDENTIAL_UNAVAILABLE', 'AUTH_CREDENTIAL_INVALID', 'SECRET_UNAVAILABLE',
  'ENVIRONMENT_UNAVAILABLE', 'APP_UNREACHABLE', 'APP_ALREADY_RUNNING',
  'SEED_DATA_MISSING', 'TEST_SETUP_FAILED', 'APP_NOT_OPEN', 'POLICY_DENIED',
  'MODEL_UNAVAILABLE', 'AUTOMATION_UNSUPPORTED', 'STEP_BUDGET_EXHAUSTED',
  'STEP_TIMEOUT', 'CONTEXT_OVERFLOW',
]);

function resultCaseStatus(status: (typeof resultStatuses)[number], attempts: QAAttempt[]): QACaseStatus {
  if (status === 'passed' || status === 'flaky' || status === 'skipped') return status;
  const lastError = attempts.at(-1)?.error;
  if (lastError && blockableCodes.has(lastError.code)) return 'blocked';
  if (lastError?.category === 'configuration' || lastError?.category === 'infrastructure' || lastError?.category === 'internal' || lastError?.category === 'interrupted') return 'error';
  return status === 'interrupted' ? 'error' : 'failed';
}

/** Only paths inside the current run's artifact directory can become links. */
function localArtifactPath(rawPath: unknown, rawDir: string): string | undefined {
  if (typeof rawPath !== 'string' || !/^[^\\\x00-\x1f?#]+$/.test(rawPath)) return undefined;
  const parts = rawPath.split('/');
  if (parts.length < 1 || parts.some((part) => part === '' || part === '.' || part === '..' || part.startsWith('.'))) return undefined;
  const candidate = path.resolve(rawDir, 'artifacts', ...parts);
  const artifactRoot = path.resolve(rawDir, 'artifacts');
  if (!candidate.startsWith(`${artifactRoot}${path.sep}`)) return undefined;
  try {
    const realRoot = realpathSync(artifactRoot);
    const realFile = realpathSync(candidate);
    if (!realFile.startsWith(`${realRoot}${path.sep}`)) return undefined;
  } catch {
    return undefined;
  }
  return `raw/artifacts/${parts.join('/')}`;
}

function normalizeAttempt(value: unknown, rawDir: string): QAAttempt {
  const item = object(value, 'attempt');
  const steps = array(item.steps, 'attempt.steps').map((value) => {
    const step = object(value, 'step');
    const model = step.model === undefined ? undefined : object(step.model, 'step.model');
    return {
      api: string(step.api, 'step.api'),
      label: string(step.label, 'step.label'),
      status: oneOf(step.status, ['passed', 'failed', 'blocked', 'timed-out', 'cancelled'], 'step.status'),
      ...(step.error === undefined ? {} : { error: rawError(step.error) }),
      ...(model === undefined ? {} : { model: {
        provider: string(model.provider, 'step.model.provider'),
        model: string(model.model, 'step.model.model'),
        inputTokens: number(model.inputTokens, 'step.model.inputTokens'),
        outputTokens: number(model.outputTokens, 'step.model.outputTokens'),
        ...(model.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: number(model.estimatedCostUsd, 'step.model.estimatedCostUsd') }),
      } }),
    };
  });
  const artifacts = array(item.artifacts, 'attempt.artifacts').map((value): QAArtifact => {
    const artifact = object(value, 'artifact');
    const redaction = oneOf(artifact.redaction, redactionStatuses, 'artifact.redaction');
    const safePath = redaction === 'incomplete' ? undefined : localArtifactPath(artifact.path, rawDir);
    return {
      kind: string(artifact.kind, 'artifact.kind'),
      redaction,
      ...(safePath === undefined ? {} : { path: safePath }),
    };
  });
  return {
    index: integer(item.index, 'attempt.index'),
    status: oneOf(item.status, attemptStatuses, 'attempt.status'),
    startedAt: string(item.startedAt, 'attempt.startedAt'),
    durationMs: number(item.durationMs, 'attempt.durationMs'),
    ...(item.error === undefined ? {} : { error: rawError(item.error) }),
    secondaryErrors: array(item.secondaryErrors, 'attempt.secondaryErrors').map(rawError),
    steps,
    artifacts,
  };
}

/** Adapt e2e's report-1 document. Any unsupported or mismatched result fails closed. */
export function normalizeReport1(raw: unknown, context: ReportContext): QAReport {
  const document = object(raw, 'root');
  if (document.schemaVersion !== 'report-1') throw new Error('Unsupported e2e report version.');
  const run = object(document.run, 'run');
  string(run.id, 'run.id');
  if (run.specVersion !== '0.1' || object(run.runner, 'run.runner').name !== 'e2e') throw new Error('The raw report runner contract does not match.');
  const rawStatus = oneOf(run.status, runStatuses, 'run.status');
  if (![0, 1, 2, 3, 4, 130].includes(run.exitCode as number)) throw new Error('Unsupported raw report exit code.');
  if (rawStatus === 'passed' && run.exitCode !== 0) throw new Error('The raw report passed status and exit code disagree.');
  string(run.startedAt, 'run.startedAt');
  string(run.finishedAt, 'run.finishedAt');
  const project = object(run.project, 'run.project');
  const targetEntries = array(run.targets, 'run.targets');
  if (rawStatus !== 'error' && project.id !== context.suite.id) throw new Error('The raw report project does not match the current suite.');
  if (rawStatus !== 'error' && !targetEntries.some((item) => object(item, 'target').id === context.target.name)) {
    throw new Error('The raw report target does not match the current run target.');
  }
  object(run.summary, 'run.summary');
  const rawResults = array(run.results, 'run.results');
  const rawErrors = array(run.errors, 'run.errors').map(rawError);
  const sourceName = path.basename(context.testFile);
  const knownTitles = new Map(context.suite.cases.map((testCase) => [`[${testCase.id}] ${testCase.title}`, testCase.id]));
  const mapped = new Map<string, { status: (typeof resultStatuses)[number]; attempts: QAAttempt[]; reason?: string }>();

  for (const value of rawResults) {
    const result = object(value, 'result');
    const titlePath = array(result.titlePath, 'result.titlePath');
    const title = titlePath.length === 1 ? string(titlePath[0], 'result.titlePath[0]') : '';
    const id = knownTitles.get(title);
    if (id === undefined || result.file !== sourceName || result.targetId !== context.target.name || result.kind !== 'test' || result.selected !== true) {
      throw new Error('The raw report test does not match the current suite, target, or test file.');
    }
    if (mapped.has(id)) throw new Error(`Duplicate test result in the raw report: ${id}`);
    const status = oneOf(result.status, resultStatuses, 'result.status');
    const attempts = array(result.attempts, 'result.attempts').map((attempt) => normalizeAttempt(attempt, context.rawDir));
    if (status !== 'skipped' && attempts.length === 0) throw new Error(`Test result has no attempts: ${id}`);
    if (status === 'passed' && attempts.at(-1)?.status !== 'passed') throw new Error(`Passed status and attempts disagree: ${id}`);
    if (status === 'flaky' && (attempts.at(-1)?.status !== 'passed' || !attempts.slice(0, -1).some((attempt) => attempt.status !== 'passed'))) {
      throw new Error(`Flaky status and attempts disagree: ${id}`);
    }
    if (context.blockedReasons.has(id) && status !== 'skipped') throw new Error(`A blocked case was recorded as executed: ${id}`);
    const skip = result.skip === undefined ? undefined : object(result.skip, 'result.skip');
    mapped.set(id, { status, attempts, ...(skip === undefined ? {} : { reason: string(skip.reason, 'result.skip.reason') }) });
  }

  const errors = rawErrors.map((error) => `${error.code}: ${error.message}`);
  const cases: QACase[] = context.suite.cases.map((testCase) => {
    const expected = expectedChecks(testCase);
    const result = mapped.get(testCase.id);
    const blockedReason = context.blockedReasons.get(testCase.id);
    if (blockedReason !== undefined) return { id: testCase.id, title: testCase.title, status: 'blocked', expected, attempts: result?.attempts ?? [], reason: blockedReason };
    if (result === undefined) return { id: testCase.id, title: testCase.title, status: 'error', expected, attempts: [], reason: 'The raw report has no result for this case.' };
    const status = resultCaseStatus(result.status, result.attempts);
    const reason = status === 'blocked' ? result.attempts.at(-1)?.error?.message ?? result.reason : result.reason;
    return { id: testCase.id, title: testCase.title, status, expected, attempts: result.attempts, ...(reason === undefined ? {} : { reason }) };
  });
  if (cases.some((item) => item.status === 'error' && !context.blockedReasons.has(item.id))) errors.push('One or more cases ended without a result or were interrupted.');
  const usage = object(run.usage, 'run.usage');
  const modelTokens = number(usage.modelTokens, 'run.usage.modelTokens');
  const reportUsage: QAReport['usage'] = {
    modelTokens,
    ...(usage.modelCachedTokens === undefined ? {} : { modelCachedTokens: number(usage.modelCachedTokens, 'run.usage.modelCachedTokens') }),
    ...(usage.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: number(usage.estimatedCostUsd, 'run.usage.estimatedCostUsd') }),
  };
  const blockedMismatch = rawStatus === 'blocked' && cases.some((item) => item.status === 'failed');
  if (blockedMismatch) {
    errors.push('The e2e blocked status conflicts with a failed case result.');
  }
  const status: QAStatus = rawStatus === 'interrupted' ? 'interrupted'
    : rawStatus === 'error' || rawErrors.length > 0 || cases.some((item) => item.status === 'error') || blockedMismatch ? 'error'
    : rawStatus === 'blocked' ? 'blocked'
    : cases.some((item) => item.status === 'failed' || item.status === 'flaky') ? 'failed'
    : cases.some((item) => item.status === 'blocked' || item.status === 'skipped') ? 'blocked'
    : rawStatus === 'failed' ? 'failed'
    : 'passed';
  return {
    schemaVersion: 'flow-qa/report-1', runId: context.runId, suiteId: context.suite.id,
    suiteHash: context.suiteHash, target: context.target, startedAt: context.startedAt,
    finishedAt: context.finishedAt, status, cases, errors, usage: reportUsage,
  };
}

/** Keep every recorded attempt when the adapter stops a still-running child. */
export function stoppedReport(raw: unknown, context: ReportContext, status: 'interrupted' | 'error', reason: string): QAReport {
  const report = normalizeReport1(raw, context);
  report.status = status;
  report.errors.push(reason);
  return report;
}

/** An explicit failure report still enumerates every expected case. */
export function failureReport(context: Omit<ReportContext, 'rawDir' | 'testFile'>, status: QAStatus, error: string): QAReport {
  return {
    schemaVersion: 'flow-qa/report-1', runId: context.runId, suiteId: context.suite.id,
    suiteHash: context.suiteHash, target: context.target, startedAt: context.startedAt,
    finishedAt: context.finishedAt, status,
    cases: context.suite.cases.map((testCase) => ({
      id: testCase.id, title: testCase.title,
      status: context.blockedReasons.has(testCase.id) ? 'blocked' : 'error',
      expected: expectedChecks(testCase), attempts: [],
      reason: context.blockedReasons.get(testCase.id) ?? error,
    })),
    errors: [error],
  };
}

function safeText(value: string, locale: Locale): string {
  return value.replace(/(?:https?:\/\/|file:\/\/)[^\s<>"'\])}]+/gi, localized(locale, '[URL hidden]', '[URL 숨김]'))
    .replace(/\[[^\]]*\]\([^)]*\)/g, localized(locale, '[link hidden]', '[링크 숨김]'))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1');
}

function evidenceLink(artifact: QAArtifact): string | undefined {
  if (artifact.redaction !== 'complete' && artifact.redaction !== 'not-required') return undefined;
  const file = artifact.path;
  if (typeof file !== 'string' || !file.startsWith('raw/artifacts/')) return undefined;
  const parts = file.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\\\x00-\x1f]/.test(part))) return undefined;
  return parts.map(encodeURIComponent).join('/');
}

export function renderMarkdown(report: QAReport, locale: Locale = 'en'): string {
  const safe = (value: string) => safeText(value, locale);
  const label = (english: string, korean: string) => localized(locale, english, korean);
  const counts = new Map<QACaseStatus, number>();
  for (const item of report.cases) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  const lines = [
    `# ${label('QA results', 'QA 결과')}: ${safe(report.suiteId)}`,
    '',
    `- ${label('Run ID', '실행 ID')}: ${safe(report.runId)}`,
    `- ${label('Target', '대상')}: ${safe(report.target.name)} ${label('(URL available in the local JSON report)', '(주소는 로컬 JSON 보고서에서 확인)')}`,
    `- ${label('Status', '상태')}: ${safe(report.status)}`,
    `- ${label('Started', '시작')}: ${safe(report.startedAt)}`,
    `- ${label('Finished', '종료')}: ${safe(report.finishedAt)}`,
    `- ${label('Results', '결과')}: ${label('passed', '통과')} ${counts.get('passed') ?? 0}, ${label('failed', '실패')} ${counts.get('failed') ?? 0}, ${label('flaky', '재시도 후 통과')} ${counts.get('flaky') ?? 0}, ${label('blocked', '차단')} ${counts.get('blocked') ?? 0}, ${label('skipped', '건너뜀')} ${counts.get('skipped') ?? 0}, ${label('error', '오류')} ${counts.get('error') ?? 0}`,
    '',
    label('## Case results', '## 케이스별 확인'),
    '',
  ];
  for (const item of report.cases) {
    lines.push(`### ${safe(item.id)} · ${safe(item.title)} — ${safe(item.status)}`, '');
    lines.push(`- ${label('Expected checks', '기대 확인')}: ${item.expected.length ? item.expected.map(safe).join('; ') : label('No explicit assertion', '명시된 검증 없음')}`);
    if (item.reason) lines.push(`- ${label('Reason', '실행 상태 근거')}: ${safe(localizeProductMessage(item.reason, locale))}`);
    if (item.attempts.length === 0) lines.push(`- ${label('Observed', '실제 확인')}: ${label('No execution attempts', '실행 시도 기록 없음')}`);
    for (const attempt of item.attempts) {
      const observed = attempt.steps.filter((step) => step.status !== 'passed').map((step) => `${safe(step.api)}: ${safe(step.label)} (${safe(step.status)})`);
      lines.push(`- ${label('Attempt', '시도')} ${attempt.index + 1}: ${safe(attempt.status)} · ${attempt.durationMs}ms`);
      if (observed.length) lines.push(`  - ${label('Observed evidence', '실제 근거')}: ${observed.join('; ')}`);
      if (attempt.error) lines.push(`  - ${label('Error', '실제 오류')}: ${safe(attempt.error.code)}: ${safe(attempt.error.message)}`);
      for (const artifact of attempt.artifacts) {
        const href = evidenceLink(artifact);
        if (href) lines.push(`  - ${label('Evidence', '증거')}: [${safe(artifact.kind)}](${href})`);
      }
    }
    lines.push('');
  }
  if (report.errors.length) {
    lines.push(label('## Run errors', '## 실행 오류'), '');
    for (const error of report.errors) lines.push(`- ${safe(localizeProductMessage(error, locale))}`);
    lines.push('');
  }
  if (report.usage) {
    lines.push(label('## Model usage', '## 모델 사용량'), '', `- ${label('Tokens', '토큰')}: ${report.usage.modelTokens}`);
    if (report.usage.modelCachedTokens !== undefined) lines.push(`- ${label('Cached tokens', '캐시 토큰')}: ${report.usage.modelCachedTokens}`);
    if (report.usage.estimatedCostUsd !== undefined) lines.push(`- ${label('Estimated cost (USD)', '추정 비용(USD)')}: ${report.usage.estimatedCostUsd}`);
    lines.push('');
  }
  lines.push(label('## Possible causes', '## 가능한 원인'), '', label('The observed evidence alone does not establish the cause. Check the raw report and local evidence.', '실패의 원인은 위 실제 근거만으로 단정하지 않습니다. 원본 보고서와 로컬 증거를 확인하세요.'), '');
  return lines.join('\n');
}
