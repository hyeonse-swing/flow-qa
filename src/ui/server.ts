import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createPreferenceScript } from '@hyeonse/design-system/preferences';
import { chromium } from 'playwright';
import { compileSuite } from '../compiler.ts';
import { runSuite, type RunSuiteOptions, type RunSuiteResult } from '../engine.ts';
import { localeFromAcceptLanguage, localizeProductMessage, type Locale } from '../i18n.ts';
import { EvidenceError, readEvidence } from './evidence.ts';
import { buildPlanningPrompt, planFlow, PlannerError } from '../planner.ts';
import { renderMarkdown, type QAReport } from '../report.ts';
import { configSchema, idSchema, modelSchema, suiteSchema, targetSchema, type Config, type PlannerConnection, type Suite } from '../schema.ts';
import { targetFingerprint } from '../targets.ts';
import { CONFIG_FILE, sha256 } from '../workspace.ts';

const MAX_BODY = 256 * 1024;
const MAX_FLOW = 128 * 1024;
const MAX_CONFIG = 256 * 1024;
const MAX_SUITE = 512 * 1024;
const MAX_REPORT = 2 * 1024 * 1024;
const MAX_STATIC = 4 * 1024 * 1024;
const PLAN_TIMEOUT_MS = 65_000;
const CLOSE_WAIT_MS = 10_000;
const BROWSER_INSTALL_COMMAND = 'flow-qa browser install';
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const reportEnvelope = z.object({
  schemaVersion: z.literal('flow-qa/report-1'), runId: z.string().regex(RUN_ID), suiteId: idSchema,
  suiteHash: z.string(), target: z.union([
    z.object({ name: z.string(), url: z.string() }),
    z.object({ name: z.string(), kind: z.literal('mobile'), platform: z.enum(['ios', 'android']), bundleId: z.string(), device: z.string() }),
  ]),
  startedAt: z.string(), finishedAt: z.string(), status: z.enum(['passed', 'failed', 'blocked', 'error', 'interrupted']),
  cases: z.array(z.object({ id: z.string(), title: z.string(), status: z.enum(['passed', 'failed', 'flaky', 'blocked', 'skipped', 'error']),
    expected: z.array(z.string()), attempts: z.array(z.unknown()), reason: z.string().optional() }).passthrough()),
  errors: z.array(z.string()), usage: z.object({ modelTokens: z.number(), modelCachedTokens: z.number().optional(), estimatedCostUsd: z.number().optional() }).optional(),
}).passthrough();
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: path.join(PUBLIC_DIR, 'index.html'), type: 'text/html; charset=utf-8' },
  '/index.html': { file: path.join(PUBLIC_DIR, 'index.html'), type: 'text/html; charset=utf-8' },
  '/app.js': { file: path.join(PUBLIC_DIR, 'app.js'), type: 'application/javascript; charset=utf-8' },
  '/display.js': { file: path.join(PUBLIC_DIR, 'display.js'), type: 'application/javascript; charset=utf-8' },
  '/i18n.js': { file: path.join(PUBLIC_DIR, 'i18n.js'), type: 'application/javascript; charset=utf-8' },
  '/style.css': { file: path.join(PUBLIC_DIR, 'style.css'), type: 'text/css; charset=utf-8' },
  '/design-system/tokens.css': { file: fileURLToPath(import.meta.resolve('@hyeonse/design-system/tokens.css')), type: 'text/css; charset=utf-8' },
  '/design-system/components.css': { file: fileURLToPath(import.meta.resolve('@hyeonse/design-system/components.css')), type: 'text/css; charset=utf-8' },
  '/design-system/preferences.js': { file: fileURLToPath(import.meta.resolve('@hyeonse/design-system/preferences')), type: 'application/javascript; charset=utf-8' },
  '/fonts/dm-sans.woff2': { file: path.join(PUBLIC_DIR, 'fonts', 'dm-sans.woff2'), type: 'font/woff2' },
  '/fonts/noto-kr-subset.woff2': { file: path.join(PUBLIC_DIR, 'fonts', 'noto-kr-subset.woff2'), type: 'font/woff2' },
};
const INIT_SCRIPT = createPreferenceScript('flowqa-display-preferences');

class HTTPError extends Error {
  readonly status: number;
  readonly issues?: { path: string; message: string }[];
  readonly category?: string;
  constructor(status: number, message: string, details: { issues?: { path: string; message: string }[]; category?: string } = {}) {
    super(message); this.status = status; this.issues = details.issues; this.category = details.category;
  }
}

function invalid(message = 'Invalid input.'): never { throw new HTTPError(400, message); }
function notFound(): never { throw new HTTPError(404, 'The requested item was not found.'); }
const SCHEMA_FIELDS = new Set([
  'suite', 'schemaVersion', 'id', 'title', 'source', 'file', 'sha256', 'requirements', 'cases',
  'requirementIds', 'preconditions', 'questions', 'steps', 'type', 'path', 'instruction',
  'locator', 'by', 'value', 'name', 'visible', 'expected', 'match', 'flow', 'role', 'url',
  'description', 'baseURL', 'model', 'apiKeyEnv', 'clear', 'targetName', 'targetURL', 'targetFingerprint', 'suiteHash',
  'kind', 'platform', 'bundleId', 'device', 'direction',
]);
const KNOWN_SCHEMA_MESSAGES = new Map([
  ['IDs must be unique.', 'IDs must be unique.'],
  ['Every requirement must be covered by a case, including blocked cases.', 'Every requirement must be covered by a case, including blocked cases.'],
  ['Unknown requirement ID.', 'Unknown requirement ID.'],
  ['A runnable case needs an explicit assertion.', 'A runnable case needs an explicit assertion.'],
]);
function safeIssues(issues: z.ZodIssue[]): { path: string; message: string }[] {
  return issues.slice(0, 8).map((issue) => {
    let location = '$';
    for (const part of issue.path.slice(0, 10)) {
      if (typeof part === 'number' && Number.isInteger(part) && part >= 0 && part <= 100) location += `[${part}]`;
      else if (typeof part === 'string' && SCHEMA_FIELDS.has(part)) location += `.${part}`;
      else { location = '$'; break; }
    }
    const message = KNOWN_SCHEMA_MESSAGES.get(issue.message) ?? ({
      invalid_type: 'A required value is missing or has the wrong type.',
      too_small: 'The value is shorter or smaller than allowed.',
      too_big: 'The value is longer or larger than allowed.',
      invalid_format: 'The value has an invalid format.',
      invalid_value: 'The value is not allowed.',
      unrecognized_keys: 'An unsupported field is present.',
    } as Record<string, string>)[issue.code] ?? 'The value does not meet the schema rules.';
    return { path: location, message };
  });
}
function plannerFailure(error: PlannerError): HTTPError {
  if (error.code === 'http') {
    const message = error.status === 401 || error.status === 403 ? 'Check model authentication and access permissions.'
      : error.status === 429 ? 'Check the model request limit.'
      : error.status && error.status >= 500 ? 'The model service is unavailable. Try again later.'
      : 'Check the model URL and request settings.';
    return new HTTPError(502, message, { category: 'http' });
  }
  if (error.code === 'invalid-suite') {
    const allowedMessages = new Set(['A JSON object response is required.', 'A runnable case needs an expected-result assertion.',
      'Check requirement links, duplicate IDs, and assertions.', 'Check required values, types, and limits in the case schema.',
      'The suite platform must match the selected planning platform.']);
    const allowedPaths = new Set([...SCHEMA_FIELDS, 'response', 'suite', '?']);
    const issues = error.issues?.slice(0, 8).map((issue) => ({
      path: issue.path.split('.').slice(0, 8).every((part) => allowedPaths.has(part) || /^(?:0|[1-9][0-9]?)$/.test(part)) ? issue.path : 'suite',
      message: allowedMessages.has(issue.message) ? issue.message : 'Check the case schema.',
    }));
    return new HTTPError(502, 'The model returned an invalid case suite.', { category: 'invalid-suite', ...(issues ? { issues } : {}) });
  }
  if (error.code === 'cancelled') return new HTTPError(504, 'Planning was cancelled or timed out.', { category: 'cancelled' });
  return new HTTPError(502, 'Could not reach the model service. Check its URL and network connection.', { category: 'request' });
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HTTPError(400, 'Invalid input.', { issues: safeIssues(result.error.issues) });
  return result.data;
}
function jsonObject(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return invalid('Invalid JSON.'); }
}
function safeBasename(value: string, extension: '.json' | '.md'): string {
  if (!FILE_NAME.test(value) || value.includes('..') || !value.endsWith(extension)) invalid('Invalid file name.');
  return value;
}
function sourceName(suite: Suite): string | undefined {
  if (!suite.source) return undefined;
  const match = /^flows\/([^/\\]+)$/.exec(suite.source.file);
  if (!match) invalid('Invalid source flow path.');
  return safeBasename(match[1]!, '.md');
}
function headers(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Vary', 'Accept-Language');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}
function sendJSON(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
async function bodyJSON(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
    throw new HTTPError(415, 'Only JSON requests are supported.');
  }
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new HTTPError(413, 'The request body is too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += part.length;
    if (size > MAX_BODY) throw new HTTPError(413, 'The request body is too large.');
    chunks.push(part);
  }
  return jsonObject(Buffer.concat(chunks).toString('utf8'));
}

export interface UIServerOptions {
  workspace: string;
  port?: number;
  run?: (options: RunSuiteOptions) => Promise<RunSuiteResult>;
  plan?: (flow: string, model: PlannerConnection, options?: { signal?: AbortSignal; platform?: 'web' | 'mobile' }) => Promise<Suite>;
  runtime?: () => boolean | Promise<boolean>;
}

export interface UIServerHandle {
  server: Server;
  url: string;
  close(): Promise<void>;
}

/** A local-only UI over the same config, suite, run and report contracts as the CLI. */
export async function startUIServer(options: UIServerOptions): Promise<UIServerHandle> {
  const workspace = await realpath(options.workspace);
  if (!(await lstat(workspace)).isDirectory()) throw new Error('Flow QA workspace does not exist.');
  const port = options.port ?? 4310;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid UI port.');
  const token = randomBytes(32).toString('base64url');
  const run = options.run ?? runSuite;
  const plan = options.plan ?? planFlow;
  let busy = false;
  let controller: AbortController | undefined;
  let active: { id: string; kind: 'plan' | 'run'; status: 'running' | 'stopping'; title: string; startedAt: string } | null = null;
  let runTask: Promise<void> | undefined;
  let lastError: string | undefined;
  let closing = false;
  let closeTask: Promise<void> | undefined;
  const requestTasks = new Set<Promise<void>>();
  let origin = '';

  async function browserInstalled(): Promise<boolean> {
    try {
      if (options.runtime) return Boolean(await options.runtime());
      const executable = chromium.executablePath();
      if (!(await stat(executable)).isFile()) return false;
      await access(executable, constants.X_OK);
      return true;
    } catch { return false; }
  }

  async function directory(parts: string[], create = false): Promise<string | undefined> {
    let current = workspace;
    for (const part of parts) {
      current = path.join(current, part);
      let info;
      try { info = await lstat(current); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!create) return undefined;
        await mkdir(current, { mode: 0o700 });
        info = await lstat(current);
      }
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) {
        throw new HTTPError(400, 'Invalid workspace path.');
      }
    }
    return current;
  }
  async function readRegularBytes(root: string, name: string, limit: number): Promise<Buffer> {
    const file = path.join(root, name);
    let info;
    try { info = await lstat(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') notFound();
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit || await realpath(file) !== file) notFound();
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > limit) notFound();
      return await handle.readFile();
    } finally { await handle.close(); }
  }
  async function readRegular(root: string, name: string, limit: number): Promise<string> {
    return (await readRegularBytes(root, name, limit)).toString('utf8');
  }
  async function writeNew(root: string, name: string, content: string): Promise<void> {
    const handle = await open(path.join(root, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(content, 'utf8'); }
    finally { await handle.close(); }
  }
  async function config(): Promise<Config> {
    const text = await readRegular(workspace, CONFIG_FILE, MAX_CONFIG);
    try { return configSchema.parse(jsonObject(text)); }
    catch { throw new HTTPError(500, 'Could not read the Flow QA configuration.'); }
  }
  async function updateConfig(next: Config): Promise<void> {
    const file = path.join(workspace, CONFIG_FILE);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file) invalid('Invalid configuration file path.');
    const temp = `.flowqa-config-${randomUUID()}.tmp`;
    await writeNew(workspace, temp, `${JSON.stringify(configSchema.parse(next), null, 2)}\n`);
    try { await rename(path.join(workspace, temp), file); }
    finally { try { await unlink(path.join(workspace, temp)); } catch { /* renamed */ } }
  }
  async function readSource(suite: Suite, verify: boolean): Promise<string | undefined> {
    const name = sourceName(suite);
    if (!name) return undefined;
    const root = await directory(['flows']);
    if (!root) notFound();
    const flow = await readRegular(root, name, MAX_FLOW);
    if (verify && sha256(flow) !== suite.source!.sha256) {
      throw new HTTPError(409, 'The source flow changed. Save the cases again.');
    }
    return flow;
  }
  async function getSuite(file: string, verify = false): Promise<{ suite: Suite; suiteHash: string; script: string; flow?: string }> {
    safeBasename(file, '.json');
    const root = await directory(['cases']);
    if (!root) notFound();
    const suite = parse(suiteSchema, jsonObject(await readRegular(root, file, MAX_SUITE)));
    const flow = await readSource(suite, verify);
    return { suite, suiteHash: sha256(JSON.stringify(suite)), script: compileSuite(suite), ...(flow === undefined ? {} : { flow }) };
  }
  async function suites() {
    const root = await directory(['cases']);
    if (!root) return [];
    const files = (await readdir(root)).filter((name) => FILE_NAME.test(name) && !name.includes('..') && name.endsWith('.json'));
    const summaries: { file: string; id: string; title: string; caseCount: number; questionCount: number }[] = [];
    for (const file of files) {
      try {
        const suite = parse(suiteSchema, jsonObject(await readRegular(root, file, MAX_SUITE)));
        sourceName(suite);
        summaries.push({ file, id: suite.id, title: suite.title, caseCount: suite.cases.length,
          questionCount: suite.cases.reduce((count, testCase) => count + testCase.questions.length, 0) });
      } catch { /* An invalid or unsafe local file is not offered through the UI. */ }
    }
    return summaries.sort((a, b) => a.file.localeCompare(b.file));
  }
  async function runDirectory(runId: string): Promise<string> {
    if (!RUN_ID.test(runId)) invalid('Invalid run ID.');
    const root = await directory(['.flowqa', 'runs']);
    if (!root) notFound();
    const dir = path.join(root, runId);
    let info;
    try { info = await lstat(dir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') notFound();
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(dir) !== dir) notFound();
    return dir;
  }
  async function report(runId: string, includeMarkdown: boolean, locale: Locale = 'en'): Promise<{ report: QAReport; markdown?: string }> {
    const dir = await runDirectory(runId);
    const parsed = reportEnvelope.safeParse(jsonObject(await readRegular(dir, 'qa-report.json', MAX_REPORT)));
    if (!parsed.success || parsed.data.runId !== runId) notFound();
    const raw = parsed.data as QAReport;
    let markdown = includeMarkdown ? await readRegular(dir, 'qa-report.md', MAX_REPORT) : undefined;
    if (markdown !== undefined && locale === 'ko') {
      try { markdown = renderMarkdown(raw, locale); }
      catch { /* Preserve the saved report when an older or malformed JSON report cannot be rendered. */ }
    }
    return { report: raw as QAReport, ...(markdown === undefined ? {} : { markdown }) };
  }
  async function runs() {
    const root = await directory(['.flowqa', 'runs']);
    if (!root) return [];
    const candidates: { id: string; mtime: number }[] = [];
    for (const id of await readdir(root)) {
      if (!RUN_ID.test(id)) continue;
      try {
        const info = await lstat(path.join(root, id));
        if (info.isDirectory() && !info.isSymbolicLink()) candidates.push({ id, mtime: info.mtimeMs });
      } catch { /* incomplete run */ }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    const history: { runId: string; suiteId: string; status: QAReport['status']; startedAt: string; finishedAt: string;
      caseCount: number; passedCount: number; target: QAReport['target'] }[] = [];
    for (const candidate of candidates) {
      if (history.length === 50) break;
      try {
        const { report: item } = await report(candidate.id, false);
        history.push({ runId: item.runId, suiteId: item.suiteId, status: item.status, startedAt: item.startedAt,
          finishedAt: item.finishedAt, caseCount: item.cases.length,
          passedCount: item.cases.filter((entry) => entry.status === 'passed' || entry.status === 'flaky').length,
          target: item.target });
      } catch { /* incomplete or unsafe run */ }
    }
    return history;
  }
  function modelState(model: Config['planner'] | Config['agent']) {
    if (!model) return { configured: false, kind: 'openai-compatible' as const, keyReady: false };
    return { configured: true, kind: 'openai-compatible' as const, model: model.model, baseURL: model.baseURL,
      ...(model.apiKeyEnv ? { apiKeyEnv: model.apiKeyEnv } : {}), keyReady: !model.apiKeyEnv || Boolean(process.env[model.apiKeyEnv]) };
  }
  function enterMutation(): void {
    if (closing) throw new HTTPError(503, 'The UI server is shutting down.');
    if (busy) throw new HTTPError(409, 'Another operation is in progress.');
    busy = true;
  }
  async function mutation<T>(work: () => Promise<T>): Promise<T> {
    enterMutation();
    try { return await work(); }
    finally { busy = false; }
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    headers(response);
    const locale = localeFromAcceptLanguage(request.headers['accept-language']);
    if (request.headers.host !== origin.slice('http://'.length) ||
      (request.headers.origin && request.headers.origin !== origin) ||
      (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site'])))) {
      throw new HTTPError(403, 'Invalid request origin.');
    }
    const url = new URL(request.url ?? '/', origin);
    if (url.origin !== origin) throw new HTTPError(403, 'Invalid request origin.');
    if (request.method === 'GET') {
      if (url.pathname === '/api/state') {
        const settings = await config();
        const history = await runs();
        sendJSON(response, 200, { csrfToken: token,
          targets: Object.entries(settings.targets).map(([name, target]) => ({ name, ...target, targetFingerprint: targetFingerprint(target) })),
          models: { planner: modelState(settings.planner), agent: modelState(settings.agent) },
          runtime: { browserInstalled: await browserInstalled(), browserInstallCommand: BROWSER_INSTALL_COMMAND },
          suites: await suites(), runs: history,
          active: active?.kind === 'plan' ? { ...active, title: localizeProductMessage(active.title, locale) } : active,
          ...(history[0] ? { lastRunId: history[0].runId } : {}),
          ...(lastError ? { lastError: localizeProductMessage(lastError, locale) } : {}) });
        return;
      }
      if (url.pathname === '/api/suite') {
        const file = url.searchParams.get('file');
        if (!file) invalid('A case file name is required.');
        sendJSON(response, 200, await getSuite(file, true)); return;
      }
      if (url.pathname === '/api/report') {
        const runId = url.searchParams.get('runId');
        if (!runId) invalid('A run ID is required.');
        sendJSON(response, 200, await report(runId, true, locale)); return;
      }
      if (url.pathname === '/api/artifact') {
        const runId = url.searchParams.get('runId');
        const caseId = url.searchParams.get('caseId');
        const attemptText = url.searchParams.get('attempt');
        const artifactText = url.searchParams.get('artifact');
        const download = url.searchParams.get('download');
        if (!runId || !caseId || !idSchema.safeParse(caseId).success ||
          !attemptText || !/^(0|[1-9][0-9]{0,3})$/.test(attemptText) || Number(attemptText) > 1000 ||
          !artifactText || !/^(0|[1-9][0-9]{0,3})$/.test(artifactText) || Number(artifactText) > 1000 ||
          (download !== null && download !== '1')) invalid('Invalid evidence selection.');
        const selectedReport = (await report(runId, false)).report;
        const runDir = await runDirectory(runId);
        try {
          const evidence = await readEvidence(runDir, selectedReport, { caseId, attempt: Number(attemptText), artifact: Number(artifactText) });
          response.writeHead(200, {
            'Content-Type': evidence.contentType,
            'Content-Disposition': `${download === '1' ? 'attachment' : 'inline'}; filename="${evidence.filename}"`,
          });
          response.end(evidence.body);
        } catch (error) {
          if (error instanceof EvidenceError) throw new HTTPError(error.status, error.message);
          throw error;
        }
        return;
      }
      if (url.pathname === '/design-system/init.js' && !url.search) {
        response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        response.end(INIT_SCRIPT); return;
      }
      const staticFile = STATIC_FILES[url.pathname];
      if (staticFile && !url.search) {
        const assetRoot = path.dirname(staticFile.file);
        let rootInfo;
        try { rootInfo = await lstat(assetRoot); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') notFound();
          throw error;
        }
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(assetRoot) !== assetRoot) notFound();
        const content = await readRegularBytes(assetRoot, path.basename(staticFile.file), MAX_STATIC);
        response.writeHead(200, { 'Content-Type': staticFile.type }); response.end(content); return;
      }
      notFound();
    }
    if (request.method !== 'POST' || !url.pathname.startsWith('/api/')) throw new HTTPError(405, 'The request is not allowed.');
    if (request.headers['x-flowqa-token'] !== token) throw new HTTPError(403, 'Invalid request token.');
    const body = await bodyJSON(request);
    if (url.pathname === '/api/prompt') {
      const { flow, platform } = parse(z.object({ flow: z.string().min(1), platform: z.enum(['web', 'mobile']).optional() }).strict(), body);
      if (Buffer.byteLength(flow) > MAX_FLOW) throw new HTTPError(413, 'The flow is too large.');
      sendJSON(response, 200, { prompt: buildPlanningPrompt(flow, platform) }); return;
    }
    if (url.pathname === '/api/stop') {
      parse(z.object({}).strict(), body);
      if (active) active.status = 'stopping';
      if (controller) controller.abort();
      sendJSON(response, 200, { ok: true }); return;
    }
    if (url.pathname === '/api/plan') {
      const result = await mutation(async () => {
        const { flow, platform } = parse(z.object({ flow: z.string().min(1), platform: z.enum(['web', 'mobile']).optional() }).strict(), body);
        if (Buffer.byteLength(flow) > MAX_FLOW) throw new HTTPError(413, 'The flow is too large.');
        const settings = await config();
        if (!settings.planner) throw new HTTPError(409, 'A compatible planner model must be configured.');
        if (settings.planner.apiKeyEnv && !process.env[settings.planner.apiKeyEnv]) throw new HTTPError(409, 'The model key environment variable is missing.');
        const abort = new AbortController();
        const id = randomUUID();
        controller = abort;
        active = { id, kind: 'plan', status: 'running', title: 'Generating cases', startedAt: new Date().toISOString() };
        let timedOut = false;
        const onAbort = () => rejectAbort(new HTTPError(timedOut ? 504 : 409,
          timedOut ? 'Planning timed out.' : 'Planning was cancelled.',
          { category: timedOut ? 'timeout' : 'cancelled' }));
        let rejectAbort: (error: HTTPError) => void = () => undefined;
        const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
        abort.signal.addEventListener('abort', onAbort, { once: true });
        const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, PLAN_TIMEOUT_MS);
        timeout.unref();
        try {
          const result = await Promise.race([
            Promise.resolve().then(() => plan(flow, settings.planner!, { signal: abort.signal, platform })),
            aborted,
          ]);
          if (abort.signal.aborted) throw new HTTPError(timedOut ? 504 : 409, 'Planning was cancelled.', { category: timedOut ? 'timeout' : 'cancelled' });
          const parsed = suiteSchema.safeParse(result);
          if (!parsed.success) throw new HTTPError(502, 'The model returned an invalid suite.', { category: 'invalid-suite' });
          const planned = parsed.data;
          if ((planned.platform ?? 'web') !== (platform ?? 'web')) throw new HTTPError(502, 'The model returned cases for a different platform.', { category: 'invalid-suite' });
          const { source: _modelSource, ...withoutSource } = planned;
          const suite = suiteSchema.parse(withoutSource);
          return { suite, script: compileSuite(suite) };
        } catch (error) {
          if (error instanceof HTTPError) throw error;
          if (error instanceof PlannerError) throw plannerFailure(error);
          throw new HTTPError(502, 'Could not generate the plan.', { category: 'unknown' });
        } finally {
          clearTimeout(timeout);
          abort.signal.removeEventListener('abort', onAbort);
          if (controller === abort) controller = undefined;
          if (active?.id === id) active = null;
        }
      });
      sendJSON(response, 200, result); return;
    }
    if (url.pathname === '/api/import') {
      const result = await mutation(async () => {
        const { suite: inputSuite, flow } = parse(z.object({ suite: suiteSchema, flow: z.string().min(1).optional() }).strict(), body);
        if (flow !== undefined && Buffer.byteLength(flow) > MAX_FLOW) throw new HTTPError(413, 'The flow is too large.');
        sourceName(inputSuite);
        if (inputSuite.source) {
          if (flow === undefined) invalid('Select the source Markdown together with the case JSON.');
          if (sha256(flow) !== inputSuite.source.sha256) throw new HTTPError(409, 'The selected Markdown does not match the case source.');
        }
        // Import prepares a review copy; saving later assigns its workspace source path.
        const { source: _source, ...suite } = inputSuite;
        return { suite, script: compileSuite(suite) };
      });
      sendJSON(response, 200, result); return;
    }
    if (url.pathname === '/api/compile') {
      const result = await mutation(async () => {
        const { suite } = parse(z.object({ suite: suiteSchema }).strict(), body);
        await readSource(suite, true);
        return { suite, script: compileSuite(suite) };
      });
      sendJSON(response, 200, result); return;
    }
    if (url.pathname === '/api/save') {
      const result = await mutation(async () => {
        const { suite: inputSuite, flow } = parse(z.object({ suite: suiteSchema, flow: z.string().min(1).optional() }).strict(), body);
        if (flow !== undefined && Buffer.byteLength(flow) > MAX_FLOW) throw new HTTPError(413, 'The flow is too large.');
        if (flow === undefined) await readSource(inputSuite, true);
        const casesRoot = await directory(['cases'], true);
        if (!casesRoot) throw new HTTPError(500, 'Could not prepare the cases directory.');
        let suite = inputSuite;
        if (flow !== undefined) {
          const flowsRoot = await directory(['flows'], true);
          if (!flowsRoot) throw new HTTPError(500, 'Could not prepare the flows directory.');
          const flowFile = `${suite.id}-${randomUUID()}.md`;
          await writeNew(flowsRoot, flowFile, flow);
          suite = suiteSchema.parse({ ...suite, source: { file: `flows/${flowFile}`, sha256: sha256(flow) } });
        }
        const file = `${suite.id}-${randomUUID()}.json`;
        await writeNew(casesRoot, file, `${JSON.stringify(suite, null, 2)}\n`);
        return { file };
      });
      sendJSON(response, 200, result); return;
    }
    if (url.pathname === '/api/targets') {
      await mutation(async () => {
        const { name, ...input } = parse(z.union([
          z.object({ name: idSchema, kind: z.literal('mobile'), platform: z.enum(['ios', 'android']), bundleId: z.string(), device: z.string(), description: z.string().optional() }).strict(),
          z.object({ name: idSchema, kind: z.literal('web').optional(), url: z.string(), description: z.string().optional() }).strict(),
        ]), body);
        const target = parse(targetSchema, input);
        const settings = await config();
        settings.targets[name] = target;
        await updateConfig(settings);
      });
      sendJSON(response, 200, { ok: true }); return;
    }
    if (url.pathname === '/api/models') {
      await mutation(async () => {
        const change = parse(z.union([
          z.object({ role: z.enum(['planner', 'agent']), clear: z.literal(true) }).strict(),
          z.object({ role: z.enum(['planner', 'agent']), baseURL: z.string(), model: z.string(), apiKeyEnv: z.string().optional() }).strict(),
        ]), body);
        const settings = await config();
        if ('clear' in change) delete settings[change.role];
        else settings[change.role] = parse(modelSchema, { baseURL: change.baseURL, model: change.model,
          ...(change.apiKeyEnv === undefined ? {} : { apiKeyEnv: change.apiKeyEnv }) });
        await updateConfig(settings);
      });
      sendJSON(response, 200, { ok: true }); return;
    }
    if (url.pathname === '/api/run') {
      enterMutation();
      try {
        const { suite: file, suiteHash, targetName, targetURL, targetFingerprint: reviewedFingerprint } = parse(z.object({
          suite: z.string(), suiteHash: z.string().regex(/^[a-f0-9]{64}$/), targetName: idSchema,
          targetURL: z.string().optional(), targetFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        }).strict(), body);
        const selected = await getSuite(file, true);
        if (selected.suiteHash !== suiteHash) throw new HTTPError(409, 'The reviewed case file changed. Open it again to review.');
        const { suite } = selected;
        const settings = await config();
        const target = settings.targets[targetName];
        if (!target) invalid('The selected target was not found.');
        if ((suite.platform ?? 'web') !== (target.kind === 'mobile' ? 'mobile' : 'web')) {
          throw new HTTPError(409, 'The case platform and selected target do not match. Review them again.');
        }
        if (reviewedFingerprint !== undefined) {
          if (targetFingerprint(target) !== reviewedFingerprint) throw new HTTPError(409, 'The selected target changed. Review it again.');
        } else if (target.kind === 'mobile' || !targetURL || target.url !== targetURL) {
          throw new HTTPError(409, 'The selected target changed. Review it again.');
        }
        const operationId = randomUUID();
        const abort = new AbortController();
        controller = abort;
        if (closing) throw new HTTPError(503, 'The UI server is shutting down.');
        active = { id: operationId, kind: 'run', status: 'running', title: suite.title, startedAt: new Date().toISOString() };
        lastError = undefined;
        const suiteSnapshot = structuredClone(suite);
        const configSnapshot = structuredClone(settings);
        runTask = Promise.resolve().then(() => run({ workspace, suite: suiteSnapshot, config: configSnapshot, targetName, signal: abort.signal }))
          .then(() => undefined)
          .catch(() => { lastError = 'Could not complete the run. Check the local records.'; })
          .finally(() => { active = null; controller = undefined; busy = false; runTask = undefined; });
        sendJSON(response, 202, { operationId }); return;
      } catch (error) { busy = false; throw error; }
    }
    notFound();
  }

  // Refuse an unsafe config before exposing a listener. Only private run storage is initialized here.
  await config();
  const privateRoot = await directory(['.flowqa'], true);
  const runsRoot = await directory(['.flowqa', 'runs'], true);
  if (!privateRoot || !runsRoot) throw new Error('Could not prepare the run records directory.');
  await chmod(privateRoot, 0o700);
  await chmod(runsRoot, 0o700);
  try { await writeNew(privateRoot, '.gitignore', '*\n'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!(await readRegular(privateRoot, '.gitignore', 4096)).split(/\r?\n/).includes('*')) {
    throw new Error('The run records .gitignore must contain the private storage rule.');
  }
  const server = createServer((request, response) => {
    const task = route(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      headers(response);
      const locale = localeFromAcceptLanguage(request.headers['accept-language']);
      const status = error instanceof HTTPError ? error.status : 500;
      const message = error instanceof HTTPError ? error.message : 'Could not handle the request.';
      sendJSON(response, status, { error: localizeProductMessage(message, locale),
        ...(error instanceof HTTPError && error.issues ? { issues: error.issues.map((issue) => ({ ...issue, message: localizeProductMessage(issue.message, locale) })) } : {}),
        ...(error instanceof HTTPError && error.category ? { category: error.category } : {}) });
    });
    requestTasks.add(task);
    void task.finally(() => requestTasks.delete(task));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { server.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Could not resolve the UI address.'); }
  origin = `http://127.0.0.1:${address.port}`;
  return {
    server, url: origin,
    close() {
      if (closeTask) return closeTask;
      closing = true;
      controller?.abort();
      closeTask = (async () => {
        const stopped = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        server.closeIdleConnections();
        if (requestTasks.size) {
          let requestTimeout: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              Promise.allSettled([...requestTasks]),
              new Promise<void>((resolve) => { requestTimeout = setTimeout(resolve, 1_000); }),
            ]);
          } finally { clearTimeout(requestTimeout); }
        }
        server.closeAllConnections();
        await stopped;
        const pending = runTask;
        if (pending) {
          let timeout: NodeJS.Timeout | undefined;
          try { await Promise.race([pending, new Promise<void>((resolve) => { timeout = setTimeout(resolve, CLOSE_WAIT_MS); })]); }
          finally { clearTimeout(timeout); }
        }
      })();
      return closeTask;
    },
  };
}
