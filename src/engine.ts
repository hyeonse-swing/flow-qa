import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSuite } from './compiler.ts';
import { failureReport, normalizeReport1, renderMarkdown, stoppedReport, type QAReport } from './report.ts';
import { configSchema, suiteSchema, type Config, type Suite } from './schema.ts';
import { verifySuiteSource } from './workspace.ts';

export interface RunSuiteOptions {
  workspace: string;
  suite: Suite;
  config: Config;
  targetName: string;
  signal?: AbortSignal;
}

export interface RunSuiteResult { runDir: string; report: QAReport }

const TEST_FILE = 'suite.e2e.ts';
const CONFIG_FILE = 'e2e.config.ts';

function agentCase(testCase: Suite['cases'][number]): boolean {
  return testCase.steps.some((step) => step.type === 'act' || step.type === 'assertAgent');
}

function packageModule(specifier: string): string {
  return import.meta.resolve(specifier);
}

function compiledTest(suite: Suite): string {
  const source = compileSuite(suite);
  return source
    .replace("from '@e2e-dev/web'", `from ${JSON.stringify(packageModule('@e2e-dev/web'))}`)
    .replace("from 'e2e'", `from ${JSON.stringify(packageModule('e2e'))}`);
}

function generatedConfig(suite: Suite, config: Config, targetName: string, agentAvailable: boolean): string {
  const target = config.targets[targetName];
  if (!target) throw new Error(`Target not found: ${targetName}`);
  const lines = [
    `import { web } from ${JSON.stringify(packageModule('@e2e-dev/web'))};`,
  ];
  if (agentAvailable) lines.push(`import { createOpenAICompatible } from ${JSON.stringify(packageModule('@ai-sdk/openai-compatible'))};`);
  const agent = config.agent;
  const agents = agentAvailable && agent ? `,
  agents: { default: { model: createOpenAICompatible({
    name: 'flow-qa',
    baseURL: ${JSON.stringify(agent.baseURL)},
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
    ${agent.apiKeyEnv ? `apiKey: process.env[${JSON.stringify(agent.apiKeyEnv)}],` : ''}
  }).chatModel(${JSON.stringify(agent.model)}) } }` : '';
  lines.push(`export default {
  projectId: ${JSON.stringify(suite.id)},
  targets: [{ name: ${JSON.stringify(targetName)}, engine: web(), app: { url: ${JSON.stringify(target.url)} } }],
  tests: [${JSON.stringify(TEST_FILE)}],
  output: 'raw',
  reporters: ['list'],
  workers: 1,
  cache: 'off',
  trace: 'off',
  timeout: ${config.timeoutMs},
  assertionTimeout: ${Math.min(3_000, config.timeoutMs)},
  retries: ${config.retries}${agents}
};`);
  return `${lines.join('\n')}\n`;
}

function wholeRunLimit(caseCount: number, timeoutMs: number, retries: number): number {
  return Math.min(30 * 60_000, Math.max(90_000, caseCount * (timeoutMs + 5_000) * (retries + 1) + 60_000));
}

async function ownedDirectory(parent: string, name: string): Promise<string> {
  const directory = path.join(parent, name);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Run records path is not a regular directory: ${directory}`);
  return directory;
}

function stopChild(child: ReturnType<typeof spawn>, force = false): void {
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  if (force && child.pid && process.platform !== 'win32') {
    try { process.kill(-child.pid, signal); return; } catch { /* process group already exited */ }
  }
  try { child.kill(signal); } catch { /* process already exited */ }
}

async function runChild(cliPath: string, runDir: string, testFile: string, configFile: string, maxMs: number, signal?: AbortSignal): Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string; interrupted: boolean; timedOut: boolean }> {
  const stdout = createWriteStream(path.join(runDir, 'e2e.stdout.log'), { mode: 0o600 });
  const stderr = createWriteStream(path.join(runDir, 'e2e.stderr.log'), { mode: 0o600 });
  stdout.on('error', () => undefined);
  stderr.on('error', () => undefined);
  let interrupted = false;
  let timedOut = false;
  let launchError: string | undefined;
  const child = spawn(process.execPath, [cliPath, 'run', testFile, '--config', configFile, '--output', 'raw', '--workers', '1'], {
    cwd: runDir,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, E2E_TELEMETRY_DISABLED: process.env.E2E_TELEMETRY_DISABLED ?? '1' },
  });
  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);
  let forceTimer: NodeJS.Timeout | undefined;
  const terminate = () => {
    stopChild(child);
    forceTimer ??= setTimeout(() => stopChild(child, true), 5_000);
    forceTimer.unref();
  };
  const onAbort = () => { interrupted = true; terminate(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timeout = setTimeout(() => { timedOut = true; terminate(); }, maxMs);
  timeout.unref();
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', (error) => { launchError = error.message; });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  // Keep the grace timer: an exited CLI can leave a browser process in its group.
  signal?.removeEventListener('abort', onAbort);
  return { ...exit, ...(launchError ? { error: launchError } : {}), interrupted, timedOut };
}

function blockedCases(suite: Suite, config: Config): Map<string, string> {
  const blocked = new Map<string, string>();
  const missingAgent = config.agent === undefined || (config.agent.apiKeyEnv !== undefined && !process.env[config.agent.apiKeyEnv]);
  for (const testCase of suite.cases) {
    if (testCase.questions.length) blocked.set(testCase.id, `Unresolved questions: ${testCase.questions.join('; ')}`);
    else if (missingAgent && agentCase(testCase)) blocked.set(testCase.id, 'The agent model or its API key environment variable is missing, so this case was not run.');
  }
  return blocked;
}

function runnableSuite(suite: Suite, blocked: ReadonlyMap<string, string>): Suite {
  return {
    ...suite,
    cases: suite.cases.map((testCase) => blocked.has(testCase.id) && !testCase.questions.length
      ? { ...testCase, questions: [blocked.get(testCase.id)!] }
      : testCase),
  };
}

/** Run one immutable suite snapshot through the locally installed e2e CLI. */
export async function runSuite(options: RunSuiteOptions): Promise<RunSuiteResult> {
  const workspace = await realpath(options.workspace);
  const qaRoot = await ownedDirectory(workspace, '.flowqa');
  const runsRoot = await ownedDirectory(qaRoot, 'runs');
  try { await writeFile(path.join(runsRoot, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const actualRunsRoot = await realpath(runsRoot);
  if (!actualRunsRoot.startsWith(`${workspace}${path.sep}`)) throw new Error('The run records directory points outside the workspace.');
  const runId = randomUUID();
  const runDir = path.join(actualRunsRoot, runId);
  await mkdir(runDir, { recursive: false, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const suiteSnapshot = `${JSON.stringify(options.suite, null, 2)}\n`;
  const suiteHash = createHash('sha256').update(suiteSnapshot).digest('hex');
  await writeFile(path.join(runDir, 'suite.json'), suiteSnapshot, { mode: 0o600 });
  await writeFile(path.join(runDir, 'suite.sha256'), `${suiteHash}\n`, { mode: 0o600 });
  let report: QAReport;
  let blocked = new Map<string, string>();
  let target = { name: options.targetName, url: options.config?.targets?.[options.targetName]?.url ?? '' };
  const context = () => ({ suite: options.suite, runId, suiteHash, target, startedAt, finishedAt: new Date().toISOString(), blockedReasons: blocked });
  try {
    const suite = suiteSchema.parse(options.suite);
    await verifySuiteSource(suite, workspace);
    const config = configSchema.parse(options.config);
    const selectedTarget = config.targets[options.targetName];
    if (!selectedTarget) throw new Error(`Target not found: ${options.targetName}`);
    target = { name: options.targetName, url: selectedTarget.url };
    blocked = blockedCases(suite, config);
    const runnable = suite.cases.filter((testCase) => !blocked.has(testCase.id));
    const executable = runnableSuite(suite, blocked);
    const testFile = path.join(runDir, TEST_FILE);
    const configFile = path.join(runDir, CONFIG_FILE);
    const agentAvailable = runnable.some(agentCase);
    await writeFile(testFile, compiledTest(executable), { mode: 0o600 });
    await writeFile(configFile, generatedConfig(suite, config, options.targetName, agentAvailable), { mode: 0o600 });
    if (options.signal?.aborted) {
      report = failureReport(context(), 'interrupted', 'An interrupt signal arrived before the run started.');
    } else if (runnable.length === 0) {
      report = failureReport(context(), 'blocked', 'There are no runnable cases.');
      report.errors = [];
    } else {
      const cliPath = path.join(path.dirname(fileURLToPath(packageModule('e2e'))), 'cli', 'bin.js');
      if (!(await stat(cliPath)).isFile()) throw new Error('Could not find the installed e2e CLI executable.');
      const child = await runChild(cliPath, runDir, testFile, configFile, wholeRunLimit(runnable.length, config.timeoutMs, config.retries), options.signal);
      const reason = child.interrupted ? 'The e2e run stopped after an interrupt signal.'
        : child.timedOut ? 'The e2e run exceeded its overall time limit.'
        : child.error ? `Could not start the e2e process: ${child.error}` : undefined;
      let raw: unknown;
      let readError: string | undefined;
      try { raw = JSON.parse(await readFile(path.join(runDir, 'raw', 'report.json'), 'utf8')); }
      catch (error) { readError = error instanceof Error ? error.message : String(error); }
      if (raw !== undefined) {
        try {
          const reportContext = { ...context(), rawDir: path.join(runDir, 'raw'), testFile };
          report = reason === undefined ? normalizeReport1(raw, reportContext)
            : stoppedReport(raw, reportContext, child.interrupted ? 'interrupted' : 'error', reason);
        }
        catch (error) {
          if (reason === undefined) throw error;
          readError = error instanceof Error ? error.message : String(error);
          report = failureReport(context(), child.interrupted ? 'interrupted' : 'error', `${reason} Could not parse the raw report: ${readError}`);
        }
      } else if (reason !== undefined) {
        report = failureReport(context(), child.interrupted ? 'interrupted' : 'error', `${reason} No raw report was found for this run.`);
      } else {
        throw new Error(`The e2e raw report for this run is missing or unreadable (exit: ${child.code ?? child.signal ?? 'unknown'}). ${readError ?? ''}`);
      }
      if (reason === undefined) {
        if (child.signal !== null) throw new Error(`The e2e process exited after signal ${child.signal}.`);
        if (child.code !== 0 && report.status === 'passed') throw new Error(`The e2e process exited with ${child.code ?? child.signal ?? 'unknown'}, but the raw report says passed.`);
        if (child.code === 0 && (report.status === 'error' || report.status === 'interrupted')) report.errors.push('The e2e exit status and report result disagree.');
      }
    }
  } catch (error) {
    report = failureReport(context(), options.signal?.aborted ? 'interrupted' : 'error', error instanceof Error ? error.message : String(error));
  }
  await writeFile(path.join(runDir, 'qa-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(runDir, 'qa-report.md'), renderMarkdown(report), { mode: 0o600 });
  return { runDir, report };
}
