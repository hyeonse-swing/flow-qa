import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, access, stat, lstat, readdir, realpath, open } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { localeFromEnv, localized, localizeProductMessage, type Locale } from './i18n.ts';
import { configSchema, idSchema, modelSchema, targetSchema } from './schema.ts';
import { initWorkspace, readConfig, readSuite, sha256, verifySuiteSource, withConfigLock, writeConfig, writeJSON } from './workspace.ts';
import { buildPlanningPrompt, planFlow } from './planner.ts';
import { compileSuite } from './compiler.ts';
import { CaseSelectionError, isReportSelectionValid, selectCases } from './case-selection.ts';
import { runSuite } from './engine.ts';
import { MAX_SAVED_REPORT_BYTES, RUN_ID, parseArchivedReportEnvelope, renderSavedMarkdown, type QAReport } from './report.ts';
import { registrationTarget, sameReportTarget, targetLabel, type ReportTarget } from './targets.ts';
import { compareCaseSteps } from './step-comparison.ts';
import { createAgentHandoff, reviewAgentHandoff } from './agent-handoff.ts';

const help: Record<Locale, string> = {
  en: `Flow QA — turn user flows into repeatable tests and evidence-backed QA reports

Usage: flow-qa <command> [arguments] [options]

  init [directory]                    Create configuration and a local example (preserve existing files)
  connect <name> --url <url>           Register a test target
  connect <name> --platform ios|android --bundle-id <id> --device <name-or-id>
                                      Register an installed mobile app (setup can wait until execution)
  model <planner|agent> --url <base> --model <id> [--key-env ENV_NAME]
  plan <flow.md> [--platform web|mobile] [--out cases.json]
                                      Plan cases before target setup; produce a prompt if no model is configured
  plan <flow.md> --prompt-only         Create a prompt for your current AI tool
  validate <cases.json>               Check case structure and assertions
  generate <cases.json> [--target <name>] [--out test.ts]
                                      Generate target-aware e2e code (without --target: target-neutral)
  run <cases.json> --target <name>     Run against a registered target and save a QA report
      [--case <id> ...]               Run only the selected case IDs (repeat --case for more)
  agent-handoff <cases.json> --target <name> [--case <id> ...] [--out directory]
                                      Prepare an unrun bundle for an external browser agent
  agent-review <handoff-dir> <result.json>
                                      Check agent-supplied findings and evidence references
  report <run-directory>              View a saved QA report
  reruns <run-directory>              List runs prepared from a saved report
  compare <run-a> <run-b>              Compare case results and authored steps
  ui [--demo] [--port 4310]           Start the local QA UI
  browser install [--with-deps]       Install this package's Playwright Chromium
  doctor                              Check the local engine and connections

Common: --workspace <directory> (default: current directory), --lang en|ko, --help
First step: flow-qa init
Local example: flow-qa ui --demo
`,
  ko: `Flow QA — 유저 플로우에서 반복 가능한 테스트와 QA 리포트까지

사용법: flow-qa <command> [arguments] [options]

  init [directory]                    설정과 로컬 예제 생성 (기존 파일 보존)
  connect <name> --url <url>           테스트 대상 등록
  connect <name> --platform ios|android --bundle-id <id> --device <name-or-id>
                                      설치된 모바일 앱 등록 (실행 전까지 설정 가능)
  model <planner|agent> --url <base> --model <id> [--key-env ENV_NAME]
  plan <flow.md> [--platform web|mobile] [--out cases.json]
                                      대상 설정 전에 케이스 설계; 모델 미연결 시 프롬프트 생성
  plan <flow.md> --prompt-only         현재 사용하는 AI에 전달할 프롬프트 생성
  validate <cases.json>               케이스 구조와 검증 조건 확인
  generate <cases.json> [--target <name>] [--out test.ts]
                                      대상별 e2e 코드 생성 (--target 생략 시 대상 중립)
  run <cases.json> --target <name>     연결한 대상에서 실행하고 QA 리포트 저장
      [--case <id> ...]               선택한 케이스만 실행 (--case를 반복해 여러 개 선택)
  agent-handoff <cases.json> --target <name> [--case <id> ...] [--out directory]
                                      외부 브라우저 에이전트에 전달할 미실행 묶음 준비
  agent-review <handoff-dir> <result.json>
                                      에이전트 관찰 결과와 증거 파일 참조 검사
  report <run-directory>              저장된 QA 리포트 보기
  reruns <run-directory>              저장된 리포트에서 시작한 재실행 찾기
  compare <run-a> <run-b>             케이스 결과와 원본 단계 비교
  ui [--demo] [--port 4310]           로컬 QA 화면 실행
  browser install [--with-deps]       패키지의 Playwright Chromium 설치
  doctor                             로컬 엔진과 연결 설정 확인

공통: --workspace <directory> (기본: 현재 폴더), --lang en|ko, --help
첫 시작: flow-qa init
로컬 예제: flow-qa ui --demo
`,
};

function required(value: string | undefined, label: string, locale: Locale): string {
  if (!value) throw new Error(localized(locale, `${label} is required. See --help.`, `${label}이 필요합니다. --help를 참고하세요.`));
  return value;
}
function safeText(value: unknown): string { return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '); }
async function writeOutput(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { flag: 'wx', mode: 0o600 });
}
export function playwrightInstallInvocation(withDeps = false): { command: string; args: string[] } {
  const packageFile = fileURLToPath(import.meta.resolve('playwright/package.json'));
  return { command: process.execPath, args: [resolve(dirname(packageFile), 'cli.js'), 'install', 'chromium', ...(withDeps ? ['--with-deps'] : [])] };
}
async function installBrowser(withDeps: boolean, locale: Locale): Promise<void> {
  const { command, args } = playwrightInstallInvocation(withDeps);
  if (!(await stat(args[0]!)).isFile()) throw new Error(localized(locale, 'Could not find the installed Playwright CLI.', '설치된 Playwright CLI를 찾지 못했습니다.'));
  await new Promise<void>((done, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? done() : reject(new Error(localized(locale, `Chromium installation did not complete (exit: ${code ?? signal ?? 'unknown'}).`, `Chromium 설치가 완료되지 않았습니다 (종료: ${code ?? signal ?? 'unknown'}).`))));
  });
}
async function installedVersion(name: string, locale: Locale): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.resolve(name)));
  for (let depth = 0; depth < 6; depth++) {
    try {
      const value = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (value.name === name && typeof value.version === 'string') return value.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(localized(locale, `Could not find installed ${name} package information.`, `설치된 ${name} 패키지 정보를 찾지 못했습니다.`));
}
async function chromiumInstalled(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    const executable = chromium.executablePath();
    if (!(await stat(executable)).isFile()) return false;
    await access(executable, constants.X_OK);
    return true;
  } catch { return false; }
}

export async function main(args: string[]): Promise<void> {
  let locale = localeFromEnv();
  try {
    const { positionals, values } = parseArgs({ args, allowPositionals: true, strict: true, options: {
      workspace: { type: 'string' }, url: { type: 'string' }, model: { type: 'string' },
      'key-env': { type: 'string' }, out: { type: 'string' }, target: { type: 'string' },
      case: { type: 'string', multiple: true },
      platform: { type: 'string' }, 'bundle-id': { type: 'string' }, device: { type: 'string' },
      'prompt-only': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      demo: { type: 'boolean' }, port: { type: 'string' }, 'with-deps': { type: 'boolean' }, lang: { type: 'string' },
    } });
    if (values.lang !== undefined) {
      if (values.lang !== 'en' && values.lang !== 'ko') throw new Error(localized(locale, 'Unsupported language. Use en or ko.', '지원하지 않는 언어입니다. en 또는 ko를 사용하세요.'));
      locale = values.lang;
    }
    const [command, arg, second] = positionals;
    const workspace = resolve(values.workspace ?? '.');
    if (!command || (values.help && command !== 'ui')) { console.log(help[locale]); return; }
    if (values.platform !== undefined && command !== 'connect' && command !== 'plan' ||
        (values['bundle-id'] !== undefined || values.device !== undefined) && command !== 'connect') {
      throw new Error(localized(locale, 'Platform and device options are only supported by connect and plan. See --help.', '플랫폼·기기 옵션은 connect와 plan에서만 사용할 수 있습니다. --help를 참고하세요.'));
    }
    if (values.case !== undefined && command !== 'run' && command !== 'agent-handoff' || values.demo && command !== 'ui' || values.port && command !== 'ui' ||
      values['with-deps'] && (command !== 'browser' || arg !== 'install')) throw new Error(localized(locale, 'This option is not supported for the command. See --help.', '이 명령에서 사용할 수 없는 옵션입니다. --help를 참고하세요.'));
    if (command === 'ui') {
      if (arg || second) throw new Error(localized(locale, 'The ui command does not accept positional arguments.', 'ui 명령에는 위치 인자를 사용할 수 없습니다.'));
      const forwarded = [
        ...(values.workspace ? ['--workspace', values.workspace] : []),
        ...(values.port ? ['--port', values.port] : []),
        ...(values.demo ? ['--demo'] : []),
        ...(values.help ? ['--help'] : []),
        '--lang', locale,
      ];
      await (await import('./ui/entry.ts')).main(forwarded);
      return;
    }
    if (command === 'browser') {
      if (arg !== 'install' || second) throw new Error(localized(locale, 'The browser command only supports install. See --help.', 'browser 명령은 install만 지원합니다. --help를 참고하세요.'));
      await installBrowser(Boolean(values['with-deps']), locale);
      return;
    }
    if (command === 'init') {
      const dir = resolve(workspace, arg ?? '.');
      const files = await initWorkspace(dir);
      console.log(localized(locale, `Workspace: ${dir}\nCreated: ${files.join(', ') || 'none (existing files preserved)'}`, `워크스페이스: ${dir}\n생성: ${files.join(', ') || '없음 (기존 파일 보존)'}`)); return;
    }
    if (command === 'connect') {
      const name = idSchema.parse(required(arg, localized(locale, 'Target name', '대상 이름'), locale));
      const platform = values.platform ?? 'web';
      if (!['web', 'ios', 'android'].includes(platform)) throw new Error(localized(locale, 'Target platform must be web, ios, or android.', '대상 플랫폼은 web, ios, android 중 하나여야 합니다.'));
      if (platform === 'web' && (values['bundle-id'] !== undefined || values.device !== undefined) || platform !== 'web' && values.url !== undefined) {
        throw new Error(localized(locale, 'Use --url for web, or --bundle-id and --device for a mobile app.', '웹은 --url, 모바일 앱은 --bundle-id와 --device를 사용하세요.'));
      }
      const target = targetSchema.parse(platform === 'web'
        ? { url: required(values.url, '--url', locale) }
        : { kind: 'mobile', platform, bundleId: required(values['bundle-id'], '--bundle-id', locale), device: required(values.device, '--device', locale) });
      const saved = await withConfigLock(workspace, async () => {
        const config = await readConfig(workspace);
        config.targets[name] = registrationTarget(target, config.targets[name]);
        await writeConfig(workspace, config);
        return config.targets[name]!;
      });
      console.log(localized(locale, `Target ${name} saved: ${targetLabel(saved)}. No app has been launched.`, `대상 ${name} 저장: ${targetLabel(saved)}. 앱은 실행하지 않았습니다.`)); return;
    }
    if (command === 'model') {
      if (arg !== 'planner' && arg !== 'agent') throw new Error(localized(locale, 'Model role must be planner or agent.', '모델 종류는 planner 또는 agent여야 합니다.'));
      const base = { baseURL: required(values.url, '--url', locale), model: required(values.model, '--model', locale), ...(values['key-env'] ? { apiKeyEnv: values['key-env'] } : {}) };
      const connection = modelSchema.parse(base);
      await withConfigLock(workspace, async () => {
        const config = await readConfig(workspace);
        config[arg] = connection;
        await writeConfig(workspace, config);
      });
      console.log(localized(locale, `${arg} model connection saved. No model call has been made. API key values are not saved in the configuration file.`, `${arg} 모델 연결 설정 저장. 실제 호출 전입니다. API 키 값은 설정 파일에 저장하지 않습니다.`)); return;
    }
    if (command === 'plan') {
      const platform = values.platform ?? 'web';
      if (platform !== 'web' && platform !== 'mobile') throw new Error(localized(locale, 'Planning platform must be web or mobile.', '설계 플랫폼은 web 또는 mobile이어야 합니다.'));
      const flowPath = resolve(workspace, required(arg, localized(locale, 'Flow file', '플로우 파일'), locale));
      const flow = await readFile(flowPath, 'utf8');
      if (Buffer.byteLength(flow) > 128_000) throw new Error(localized(locale, 'The flow file must be 128 KB or smaller.', '플로우 파일은 128 KB 이하여야 합니다.'));
      const config = await readConfig(workspace);
      const stem = basename(flowPath).replace(/\.[^.]+$/, '');
      if (values['prompt-only'] || !config.planner) {
        const output = resolve(workspace, values.out ?? `planning/${stem}.prompt.md`);
        await writeOutput(output, buildPlanningPrompt(flow, platform));
        console.log(localized(locale, `Planning prompt: ${output}\nSend it to your AI tool, save the returned JSON under cases/, then run validate → generate → run.`, `설계 프롬프트: ${output}\n연결된 AI에 전달하고 응답 JSON을 cases/에 저장한 뒤 validate → generate → run을 실행하세요.`)); return;
      }
      const output = resolve(workspace, values.out ?? `cases/${stem}.json`);
      try { await access(output); throw new Error(localized(locale, 'The output file already exists. Use --out to choose a new path.', '출력 파일이 이미 있습니다. --out으로 새 경로를 지정하세요.')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const suite = await planFlow(flow, config.planner, { platform });
      suite.source = { file: arg!, sha256: sha256(flow) };
      await writeJSON(output, suite, true);
      console.log(localized(locale, `Cases created: ${output}\n${suite.cases.filter((c) => c.questions.length).length} of ${suite.cases.length} cases have open questions.`, `케이스 생성: ${output}\n${suite.cases.length}개 중 확인 질문이 있는 케이스 ${suite.cases.filter((c) => c.questions.length).length}개`)); return;
    }
    if (command === 'agent-review') {
      const handoff = resolve(workspace, required(arg, localized(locale, 'Handoff directory', '전달 묶음 폴더'), locale));
      const result = resolve(workspace, required(second, localized(locale, 'Agent result file', '에이전트 결과 파일'), locale));
      console.log(await reviewAgentHandoff(handoff, result)); return;
    }
    if (command === 'validate' || command === 'generate' || command === 'run' || command === 'agent-handoff') {
      const suitePath = resolve(workspace, required(arg, localized(locale, 'Case file', '케이스 파일'), locale));
      if (command === 'agent-handoff' && (await stat(suitePath)).size > 1_000_000) throw new Error('The case file must be 1 MB or smaller for an external agent handoff.');
      const suite = await readSuite(suitePath);
      await verifySuiteSource(suite, workspace);
      if (command === 'validate') {
        console.log(localized(locale, `${suite.id}: ${suite.cases.length} valid cases. Blocked by questions: ${suite.cases.filter((c) => c.questions.length).length}`, `${suite.id}: ${suite.cases.length}개 케이스 유효. 질문으로 차단된 케이스: ${suite.cases.filter((c) => c.questions.length).length}`)); return;
      }
      if (command === 'generate') {
        const output = resolve(workspace, values.out ?? `generated/${suite.id}.e2e.ts`);
        const targetName = values.target;
        const target = targetName === undefined ? undefined : (await readConfig(workspace)).targets[targetName];
        if (targetName !== undefined && !target) throw new Error(localized(locale, `Target not found: ${targetName}`, `대상을 찾지 못했습니다: ${targetName}`));
        if (target && (suite.platform ?? 'web') !== (target.kind === 'mobile' ? 'mobile' : 'web')) {
          throw new Error(localized(locale, 'The case platform and selected target do not match.', '케이스 플랫폼과 선택한 대상이 일치하지 않습니다.'));
        }
        await writeOutput(output, compileSuite(suite, target));
        console.log(localized(locale,
          `Test script (${targetName ? `target: ${targetName}` : 'target-neutral; use --target to match a run'}): ${output}`,
          `실행 스크립트 (${targetName ? `대상: ${targetName}` : '대상 중립; 실행과 일치시키려면 --target 사용'}): ${output}`)); return;
      }
      if (command === 'agent-handoff') {
        const config = await readConfig(workspace);
        const targetName = required(values.target, '--target', locale);
        const target = config.targets[targetName];
        if (!target) throw new Error(localized(locale, `Target not found: ${targetName}`, `대상을 찾지 못했습니다: ${targetName}`));
        let caseIds: string[] | undefined;
        try { caseIds = selectCases(suite, values.case).selection?.caseIds; }
        catch (error) {
          if (error instanceof CaseSelectionError) throw new Error(localizeProductMessage('Select one or more unique cases from this suite.', locale));
          throw error;
        }
        const directory = await createAgentHandoff({ workspace, suite, targetName, target,
          ...(caseIds ? { caseIds } : {}), ...(values.out ? { out: values.out } : {}) });
        console.log(localized(locale,
          `External agent handoff: ${directory}\nNo test has run. Review request.json and case values before sharing; give AGENT_PROMPT.md to your agent.`,
          `외부 에이전트 전달 묶음: ${directory}\n테스트는 실행되지 않았습니다. 공유 전에 request.json과 케이스 값을 검토하고 AGENT_PROMPT.md를 에이전트에 전달하세요.`));
        return;
      }
      const config = await readConfig(workspace);
      const targetName = values.target ?? (Object.keys(config.targets).length === 1 ? Object.keys(config.targets)[0] : undefined);
      let caseIds: string[] | undefined;
      try { caseIds = selectCases(suite, values.case).selection?.caseIds; }
      catch (error) {
        if (error instanceof CaseSelectionError) throw new Error(localizeProductMessage('Select one or more unique cases from this suite.', locale));
        throw error;
      }
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
      try {
        const { report, runDir } = await runSuite({ workspace, suite, config, targetName: required(targetName, '--target', locale), signal: controller.signal,
          ...(caseIds ? { caseIds } : {}) });
        if (report.selection) console.log(localized(locale, `Selected run: ${report.selection.caseIds.length}/${report.selection.totalCases} cases; the full suite was not evaluated.`, `선택 실행: ${report.selection.totalCases}개 중 ${report.selection.caseIds.length}개. 전체 케이스를 검증한 결과가 아닙니다.`));
        console.log(localized(locale, `Run result: ${report.status}\nQA report: ${resolve(runDir, 'qa-report.md')}\nRaw result: ${resolve(runDir, 'qa-report.json')}`, `실행 결과: ${report.status}\nQA 리포트: ${resolve(runDir, 'qa-report.md')}\n원본 결과: ${resolve(runDir, 'qa-report.json')}`));
        process.exitCode = report.status === 'passed' ? 0 : report.status === 'interrupted' ? 130 : 1;
      } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
      return;
    }
    if (command === 'report') {
      const runDirectory = resolve(workspace, required(arg, localized(locale, 'Run directory', '실행 폴더'), locale));
      let content = await readFile(resolve(runDirectory, 'qa-report.md'), 'utf8');
      try { content = renderSavedMarkdown(JSON.parse(await readFile(resolve(runDirectory, 'qa-report.json'), 'utf8')), content, locale); }
      catch { /* Preserve the saved Markdown when normalized JSON is absent or malformed. */ }
      console.log(content.replace(/\u001b/g, '')); return;
    }
    if (command === 'reruns') {
      if (second) throw new Error(localized(locale, 'reruns accepts one run directory.', 'reruns에는 실행 폴더 하나만 지정하세요.'));
      const canonicalWorkspace = await realpath(workspace);
      let root = canonicalWorkspace;
      for (const part of ['.flowqa', 'runs']) {
        root = join(root, part);
        const info = await lstat(root);
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) {
          throw new Error(localized(locale, 'Invalid workspace run path.', '작업 공간의 실행 경로가 유효하지 않습니다.'));
        }
      }
      const selectedDir = resolve(workspace, required(arg, localized(locale, 'Run directory', '실행 폴더'), locale));
      const originalId = basename(selectedDir);
      const selectedInfo = await lstat(selectedDir);
      if (!RUN_ID.test(originalId) || selectedInfo.isSymbolicLink() ||
        await realpath(selectedDir) !== join(root, originalId)) {
        throw new Error(localized(locale, 'Choose a saved run in this workspace.', '이 작업 공간에 저장된 실행을 선택하세요.'));
      }
      const readReport = async (id: string): Promise<QAReport | undefined> => {
        const dir = join(root, id);
        const dirInfo = await lstat(dir);
        if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink() || await realpath(dir) !== dir) return undefined;
        const file = join(dir, 'qa-report.json');
        const fileInfo = await lstat(file);
        if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > MAX_SAVED_REPORT_BYTES ||
          await realpath(file) !== file) return undefined;
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        let contents: string;
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.size > MAX_SAVED_REPORT_BYTES) return undefined;
          contents = await handle.readFile('utf8');
        } finally { await handle.close(); }
        const report = parseArchivedReportEnvelope(JSON.parse(contents));
        return report?.runId === id ? report : undefined;
      };
      let original: QAReport | undefined;
      try { original = await readReport(originalId); } catch { /* Invalid saved run. */ }
      if (!original) throw new Error(localized(locale, 'This is not a valid saved run.', '유효한 저장 실행이 아닙니다.'));
      const matches: { id: string; status: QAReport['status']; mtime: number }[] = [];
      for (const id of await readdir(root)) {
        if (!RUN_ID.test(id) || id === originalId) continue;
        try {
          const report = await readReport(id);
          if (report?.parentRunId !== originalId) continue;
          matches.push({ id, status: report.status, mtime: (await lstat(join(root, id))).mtimeMs });
        } catch { /* Incomplete or unsafe saved run. */ }
      }
      matches.sort((a, b) => b.mtime - a.mtime || a.id.localeCompare(b.id));
      if (!matches.length) {
        console.log(localized(locale, 'No runs were prepared from this report.', '이 리포트에서 시작한 재실행이 없습니다.'));
        return;
      }
      for (const item of matches) console.log(`${item.status}\t.flowqa/runs/${item.id}`);
      return;
    }
    if (command === 'compare') {
      const load = async (dir: string | undefined) => {
        const data = JSON.parse(await readFile(resolve(workspace, required(dir, localized(locale, 'Run directory', '실행 폴더'), locale), 'qa-report.json'), 'utf8'));
        if (!Array.isArray(data.cases) || typeof data.suiteHash !== 'string' || typeof data.suiteId !== 'string') throw new Error(localized(locale, 'This is not a valid QA report.', '유효한 QA 리포트가 아닙니다.'));
        if (!data.target || typeof data.target.name !== 'string') throw new Error(localized(locale, 'This is not a valid QA report.', '유효한 QA 리포트가 아닙니다.'));
        const { name: _targetName, ...identity } = data.target;
        if (!targetSchema.safeParse(identity).success) throw new Error(localized(locale, 'This is not a valid QA report.', '유효한 QA 리포트가 아닙니다.'));
        if (!isReportSelectionValid(data.cases, data.selection)
          || !data.cases.every((item: { status?: unknown }) => ['passed', 'failed', 'flaky', 'blocked', 'skipped', 'error'].includes(item.status as string))) {
          throw new Error(localized(locale, 'This is not a valid QA report.', '유효한 QA 리포트가 아닙니다.'));
        }
        return data as QAReport;
      };
      const before = await load(arg), after = await load(second);
      if (before.runId && before.runId === after.runId) {
        throw new Error(localized(locale, 'A comparison needs two different runs.', '서로 다른 두 실행을 선택해야 합니다.'));
      }
      const sameSelection = JSON.stringify(before.cases.map((item) => item.id).sort()) === JSON.stringify(after.cases.map((item) => item.id).sort());
      const comparable = before.suiteId === after.suiteId && before.suiteHash === after.suiteHash && sameReportTarget(before.target, after.target) && sameSelection;
      console.log(comparable ? localized(locale, 'Comparing the same suite, target and case selection (check external data state separately)', '동일 명세·대상·케이스 범위 비교 (외부 데이터 상태는 별도 확인)') : localized(locale, 'Suite, target or case selection differs; no direct regression verdict is made.', '명세·대상 또는 케이스 범위가 달라 직접적인 회귀 판정은 하지 않습니다.'));
      if (before.selection || after.selection) console.log(localized(locale, 'This comparison includes selected cases only; omitted cases were not evaluated.', '이 비교에는 선택 실행이 포함되어 있습니다. 미선택 케이스는 검증되지 않았습니다.'));
      const previous = new Map(before.cases.map((item) => [item.id, item]));
      const current = new Map(after.cases.map((item) => [item.id, item]));
      for (const id of new Set([...previous.keys(), ...current.keys()])) {
        const baselineCase = previous.get(id);
        const currentCase = current.get(id);
        console.log(`${safeText(id)}: ${safeText(baselineCase?.status ?? localized(locale, 'not included', '미포함'))} → ${safeText(currentCase?.status ?? localized(locale, 'not included', '미포함'))}`);
        if (!comparable || !baselineCase || !currentCase) continue;
        const steps = compareCaseSteps(baselineCase, currentCase, true);
        if (steps.availability !== 'compared') continue;
        const common = steps.lastCommonPassedStepIndex === undefined ? localized(locale, 'none', '없음') : String(steps.lastCommonPassedStepIndex + 1);
        const difference = steps.firstDifferenceStepIndex === undefined ? localized(locale, 'none', '없음') : String(steps.firstDifferenceStepIndex + 1);
        console.log(localized(locale, `  Last common passed step: ${common}; first differing step: ${difference}`, `  마지막 공통 성공 단계: ${common}, 첫 결과 차이 단계: ${difference}`));
      }
      return;
    }
    if (command === 'doctor') {
      const config = configSchema.parse(await readConfig(workspace));
      const keyStatus = (apiKeyEnv: string | undefined) => !apiKeyEnv
        ? localized(locale, 'key environment variable not configured', '키 환경 변수 미지정')
        : localized(locale, `${apiKeyEnv}: ${process.env[apiKeyEnv] ? 'set' : 'missing'}`, `${apiKeyEnv}: ${process.env[apiKeyEnv] ? '설정됨' : '누락'}`);
      for (const pkg of ['e2e', '@e2e-dev/web', '@e2e-dev/mobile', 'playwright']) {
        console.log(`${pkg}: ${await installedVersion(pkg, locale)}`);
      }
      const hasChromium = await chromiumInstalled();
      console.log(localized(locale, `Node: ${process.version}\nChromium: ${hasChromium ? 'installed' : 'missing (flow-qa browser install)'}\nTargets: ${Object.keys(config.targets).join(', ') || 'none'}\nPlanner model: ${config.planner ? 'configured' : 'not configured (prompt handoff available)'}\nAgent model: ${config.agent ? 'configured' : 'not configured (deterministic tests available)'}`, `Node: ${process.version}\nChromium: ${hasChromium ? '설치됨' : '미설치 (flow-qa browser install)'}\n대상: ${Object.keys(config.targets).join(', ') || '없음'}\n설계 모델: ${config.planner ? '연결 설정됨' : '미연결 (프롬프트 전달 가능)'}\n실행 모델: ${config.agent ? '연결 설정됨' : '미연결 (고정 조작 테스트 가능)'}`));
      if (config.planner) console.log(localized(locale, `Planner API key: ${keyStatus(config.planner.apiKeyEnv)}`, `설계 모델 API 키: ${keyStatus(config.planner.apiKeyEnv)}`));
      if (config.agent) console.log(localized(locale, `Agent API key: ${keyStatus(config.agent.apiKeyEnv)}`, `실행 모델 API 키: ${keyStatus(config.agent.apiKeyEnv)}`));
      const nativeTargets = Object.entries(config.targets).filter(([, target]) => target.kind === 'mobile');
      if (nativeTargets.length) {
        for (const [name, target] of nativeTargets) console.log(localized(locale, `Mobile target ${name}: ${targetLabel(target)}`, `모바일 대상 ${name}: ${targetLabel(target)}`));
        console.log(localized(locale, 'Mobile app/device readiness is checked when you run. Saving a target does not install or launch an app.', '모바일 앱·기기 준비 상태는 실행할 때 확인합니다. 대상 저장만으로 앱을 설치하거나 실행하지 않습니다.'));
      }
      return;
    }
    throw new Error(localized(locale, `Unknown command: ${command}`, `알 수 없는 명령: ${command}`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Flow QA: ${safeText(localizeProductMessage(message, locale))}`); process.exitCode = 2;
  }
}
