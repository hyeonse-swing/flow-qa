import { z } from 'zod';

const text = z.string().trim().min(1).max(8192);
export const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const httpURL = z.string().url().refine((value) => {
  const url = new URL(value);
  const loopback = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  return (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) && !url.username && !url.password && !url.search && !url.hash;
}, 'Use HTTPS (HTTP only on loopback), without credentials, query parameters, or fragments.');

export const locatorSchema = z.discriminatedUnion('by', [
  z.object({ by: z.literal('role'), value: z.enum(['button', 'link', 'textbox', 'heading', 'checkbox', 'radio', 'combobox', 'option', 'status', 'alert', 'dialog', 'tab', 'row', 'cell', 'list', 'listitem', 'navigation', 'searchbox', 'switch']), name: text.optional() }).strict(),
  z.object({ by: z.enum(['text', 'label', 'testId']), value: text }).strict(),
]);

export const stepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('open'), path: text.refine((v) => v.startsWith('/') && !v.startsWith('//') && !v.includes('\\'), 'Use an app-relative path starting with /.') }).strict(),
  z.object({ type: z.literal('act'), instruction: text }).strict(),
  z.object({ type: z.literal('click'), locator: locatorSchema }).strict(),
  z.object({ type: z.literal('fill'), locator: locatorSchema, value: z.string().max(8192) }).strict(),
  z.object({ type: z.literal('assertVisible'), locator: locatorSchema, visible: z.boolean().default(true) }).strict(),
  z.object({ type: z.literal('assertText'), locator: locatorSchema, expected: text, match: z.enum(['equals', 'contains']).default('equals') }).strict(),
  z.object({ type: z.literal('assertUrl'), expected: text }).strict(),
  z.object({ type: z.literal('assertAgent'), instruction: text }).strict(),
]);

const caseSchema = z.object({
  id: idSchema,
  title: text,
  requirementIds: z.array(idSchema).min(1),
  preconditions: z.array(text).default([]),
  questions: z.array(text).default([]),
  steps: z.array(stepSchema).min(1).max(100),
}).strict();

export const suiteSchema = z.object({
  schemaVersion: z.literal('flow-qa/suite-1'),
  id: idSchema,
  title: text,
  source: z.object({ file: text, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  requirements: z.array(z.object({ id: idSchema, text }).strict()).min(1).max(100),
  cases: z.array(caseSchema).min(1).max(100),
}).strict().superRefine((suite, ctx) => {
  for (const [name, items] of [['requirements', suite.requirements], ['cases', suite.cases]] as const) {
    if (new Set(items.map((item) => item.id)).size !== items.length) ctx.addIssue({ code: 'custom', path: [name], message: 'IDs must be unique.' });
  }
  const ids = new Set(suite.requirements.map((r) => r.id));
  const covered = new Set(suite.cases.flatMap((test) => test.requirementIds));
  if (suite.requirements.some((r) => !covered.has(r.id))) ctx.addIssue({ code: 'custom', path: ['requirements'], message: 'Every requirement must be covered by a case, including blocked cases.' });
  suite.cases.forEach((test, index) => {
    if (test.requirementIds.some((id) => !ids.has(id))) ctx.addIssue({ code: 'custom', path: ['cases', index, 'requirementIds'], message: 'Unknown requirement ID.' });
    if (!test.questions.length && !test.steps.some((s) => s.type.startsWith('assert'))) ctx.addIssue({ code: 'custom', path: ['cases', index, 'steps'], message: 'A runnable case needs an explicit assertion.' });
  });
});

export const modelSchema = z.object({
  baseURL: httpURL,
  model: text,
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
}).strict();

export const plannerSchema = modelSchema;

export const targetSchema = z.object({
  url: httpURL,
  description: z.string().max(2000).default(''),
}).strict();

export const configSchema = z.object({
  schemaVersion: z.literal('flow-qa/config-1'),
  targets: z.record(idSchema, targetSchema),
  planner: plannerSchema.optional(),
  agent: modelSchema.optional(),
  timeoutMs: z.number().int().min(1000).max(900000).default(120000),
  retries: z.number().int().min(0).max(2).default(0),
}).strict();

export type Suite = z.infer<typeof suiteSchema>;
export type Case = Suite['cases'][number];
export type Step = z.infer<typeof stepSchema>;
export type Locator = z.infer<typeof locatorSchema>;
export type Config = z.infer<typeof configSchema>;
export type Target = z.infer<typeof targetSchema>;
export type ModelConnection = z.infer<typeof modelSchema>;
export type PlannerConnection = z.infer<typeof plannerSchema>;
