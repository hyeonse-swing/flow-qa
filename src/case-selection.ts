import type { Suite } from './schema.ts';

/** Present only when a run executes a proper subset of its original suite. */
export interface RunSelection {
  caseIds: string[];
  totalCases: number;
}

export class CaseSelectionError extends Error {}

/** Resolve requested IDs against the complete suite without changing its order or contents. */
export function selectCases(suite: Suite, caseIds?: readonly string[]): { suite: Suite; selection?: RunSelection } {
  if (caseIds === undefined) return { suite };
  if (!Array.isArray(caseIds) || caseIds.length === 0) throw new CaseSelectionError('Select at least one case ID.');
  const available = new Set(suite.cases.map((testCase) => testCase.id));
  const requested = new Set<string>();
  for (const id of caseIds) {
    if (typeof id !== 'string' || !available.has(id)) throw new CaseSelectionError(`Unknown case ID: ${String(id)}`);
    if (requested.has(id)) throw new CaseSelectionError(`Duplicate selected case ID: ${id}`);
    requested.add(id);
  }
  if (requested.size === suite.cases.length) return { suite };
  const cases = suite.cases.filter((testCase) => requested.has(testCase.id));
  const requirementIds = new Set(cases.flatMap((testCase) => testCase.requirementIds));
  return {
    suite: { ...suite, cases, requirements: suite.requirements.filter((requirement) => requirementIds.has(requirement.id)) },
    selection: { caseIds: cases.map((testCase) => testCase.id), totalCases: suite.cases.length },
  };
}

/** Check optional additive report metadata before treating a report as comparable. */
export function isReportSelectionValid(cases: readonly { id: string }[], selection: unknown): boolean {
  const caseIds = cases.map((item) => item.id);
  if (caseIds.some((id) => typeof id !== 'string' || !id.trim()) || new Set(caseIds).size !== caseIds.length) return false;
  if (selection === undefined) return true;
  if (selection === null || typeof selection !== 'object' || Array.isArray(selection)) return false;
  const prototype: unknown = Object.getPrototypeOf(selection);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Reflect.ownKeys(selection).length !== 2 || !Object.hasOwn(selection, 'caseIds') || !Object.hasOwn(selection, 'totalCases')) return false;
  const value = selection as Record<string, unknown>;
  if (!Number.isInteger(value.totalCases) || (value.totalCases as number) > 100 || (value.totalCases as number) <= caseIds.length) return false;
  if (!Array.isArray(value.caseIds) || value.caseIds.length === 0 || value.caseIds.length !== caseIds.length) return false;
  if (value.caseIds.some((id) => typeof id !== 'string' || !id.trim())) return false;
  const selected = new Set(value.caseIds);
  return selected.size === value.caseIds.length && caseIds.every((id) => selected.has(id));
}
