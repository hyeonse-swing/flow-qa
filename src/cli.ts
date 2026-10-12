import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, access, stat } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { localeFromEnv, localized, localizeProductMessage, type Locale } from './i18n.ts';
import { configSchema, idSchema, modelSchema, targetSchema } from './schema.ts';
import { initWorkspace, readConfig, readSuite, sha256, verifySuiteSource, writeConfig, writeJSON } from './workspace.ts';
import { buildPlanningPrompt, planFlow } from './planner.ts';
import { compileSuite } from './compiler.ts';
import { runSuite } from './engine.ts';
import { renderMarkdown, type QAReport } from './report.ts';

const help: Record<Locale, string> = {
  en: `Flow QA — turn user flows into repeatable tests and evidence-backed QA reports

Usage: flow-qa <command> [arguments] [options]

  init [directory]                    Create configuration and a local example (preserve existing files)
  connect <name> --url <url>           Register a test target
  model <planner|agent> --url <base> --model <id> [--key-env ENV_NAME]
  plan <flow.md> [--out cases.json]    Plan cases with a model; produce a prompt if none is configured
  plan <flow.md> --prompt-only         Create a prompt for your current AI tool
  validate <cases.json>               Check case structure and assertions
  generate <cases.json> [--out test.ts] Generate e2e test code
  run <cases.json> --target <name>     Run against a registered target and save a QA report
  report <run-directory>              View a saved QA report
  compare <run-a> <run-b>              Compare case results
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
  model <planner|agent> --url <base> --model <id> [--key-env ENV_NAME]
  plan <flow.md> [--out cases.json]    모델로 케이스 설계; 미연결 시 실행용 프롬프트 생성
  plan <flow.md> --prompt-only         현재 사용하는 AI에 전달할 프롬프트 생성
  validate <cases.json>               케이스 구조와 검증 조건 확인
  generate <cases.json> [--out test.ts] e2e 테스트 코드 생성
  run <cases.json> --target <name>     연결한 대상에서 실행하고 QA 리포트 저장
  report <run-directory>              저장된 QA 리포트 보기
  compare <run-a> <run-b>             케이스별 결과 비교
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
    if (values.demo && command !== 'ui' || values.port && command !== 'ui' ||
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
      const config = await readConfig(workspace);
      const name = idSchema.parse(required(arg, localized(locale, 'Target name', '대상 이름'), locale));
      config.targets[name] = targetSchema.parse({ url: required(values.url, '--url', locale) });
      await writeConfig(workspace, config);
      console.log(localized(locale, `Target ${name} connected: ${config.targets[name]!.url}`, `대상 ${name} 연결: ${config.targets[name]!.url}`)); return;
    }
    if (command === 'model') {
      if (arg !== 'planner' && arg !== 'agent') throw new Error(localized(locale, 'Model role must be planner or agent.', '모델 종류는 planner 또는 agent여야 합니다.'));
      const config = await readConfig(workspace);
      const base = { baseURL: required(values.url, '--url', locale), model: required(values.model, '--model', locale), ...(values['key-env'] ? { apiKeyEnv: values['key-env'] } : {}) };
      config[arg] = modelSchema.parse(base);
      await writeConfig(workspace, config);
      console.log(localized(locale, `${arg} model connection saved. No model call has been made. API key values are not saved in the configuration file.`, `${arg} 모델 연결 설정 저장. 실제 호출 전입니다. API 키 값은 설정 파일에 저장하지 않습니다.`)); return;
    }
    if (command === 'plan') {
      const flowPath = resolve(workspace, required(arg, localized(locale, 'Flow file', '플로우 파일'), locale));
      const flow = await readFile(flowPath, 'utf8');
      if (Buffer.byteLength(flow) > 128_000) throw new Error(localized(locale, 'The flow file must be 128 KB or smaller.', '플로우 파일은 128 KB 이하여야 합니다.'));
      const config = await readConfig(workspace);
      const stem = basename(flowPath).replace(/\.[^.]+$/, '');
      if (values['prompt-only'] || !config.planner) {
        const output = resolve(workspace, values.out ?? `planning/${stem}.prompt.md`);
        await writeOutput(output, buildPlanningPrompt(flow));
        console.log(localized(locale, `Planning prompt: ${output}\nSend it to your AI tool, save the returned JSON under cases/, then run validate → generate → run.`, `설계 프롬프트: ${output}\n연결된 AI에 전달하고 응답 JSON을 cases/에 저장한 뒤 validate → generate → run을 실행하세요.`)); return;
      }
      const output = resolve(workspace, values.out ?? `cases/${stem}.json`);
      try { await access(output); throw new Error(localized(locale, 'The output file already exists. Use --out to choose a new path.', '출력 파일이 이미 있습니다. --out으로 새 경로를 지정하세요.')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const suite = await planFlow(flow, config.planner);
      suite.source = { file: arg!, sha256: sha256(flow) };
      await writeJSON(output, suite, true);
      console.log(localized(locale, `Cases created: ${output}\n${suite.cases.filter((c) => c.questions.length).length} of ${suite.cases.length} cases have open questions.`, `케이스 생성: ${output}\n${suite.cases.length}개 중 확인 질문이 있는 케이스 ${suite.cases.filter((c) => c.questions.length).length}개`)); return;
    }
    if (command === 'validate' || command === 'generate' || command === 'run') {
      const suitePath = resolve(workspace, required(arg, localized(locale, 'Case file', '케이스 파일'), locale));
      const suite = await readSuite(suitePath);
      await verifySuiteSource(suite, workspace);
      if (command === 'validate') {
        console.log(localized(locale, `${suite.id}: ${suite.cases.length} valid cases. Blocked by questions: ${suite.cases.filter((c) => c.questions.length).length}`, `${suite.id}: ${suite.cases.length}개 케이스 유효. 질문으로 차단된 케이스: ${suite.cases.filter((c) => c.questions.length).length}`)); return;
      }
      if (command === 'generate') {
        const output = resolve(workspace, values.out ?? `generated/${suite.id}.e2e.ts`);
        await writeOutput(output, compileSuite(suite)); console.log(localized(locale, `Test script: ${output}`, `실행 스크립트: ${output}`)); return;
      }
      const config = await readConfig(workspace);
      const targetName = values.target ?? (Object.keys(config.targets).length === 1 ? Object.keys(config.targets)[0] : undefined);
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
      try {
        const { report, runDir } = await runSuite({ workspace, suite, config, targetName: required(targetName, '--target', locale), signal: controller.signal });
        console.log(localized(locale, `Run result: ${report.status}\nQA report: ${resolve(runDir, 'qa-report.md')}\nRaw result: ${resolve(runDir, 'qa-report.json')}`, `실행 결과: ${report.status}\nQA 리포트: ${resolve(runDir, 'qa-report.md')}\n원본 결과: ${resolve(runDir, 'qa-report.json')}`));
        process.exitCode = report.status === 'passed' ? 0 : report.status === 'interrupted' ? 130 : 1;
      } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
      return;
    }
    if (command === 'report') {
      const runDirectory = resolve(workspace, required(arg, localized(locale, 'Run directory', '실행 폴더'), locale));
      let content = await readFile(resolve(runDirectory, 'qa-report.md'), 'utf8');
      if (locale === 'ko') {
        try { content = renderMarkdown(JSON.parse(await readFile(resolve(runDirectory, 'qa-report.json'), 'utf8')) as QAReport, locale); }
        catch { /* Preserve the saved report if an older or malformed JSON report cannot be rendered. */ }
      }
      console.log(content.replace(/\u001b/g, '')); return;
    }
    if (command === 'compare') {
      const load = async (dir: string | undefined) => {
        const data = JSON.parse(await readFile(resolve(workspace, required(dir, localized(locale, 'Run directory', '실행 폴더'), locale), 'qa-report.json'), 'utf8'));
        if (!Array.isArray(data.cases) || typeof data.suiteHash !== 'string' || typeof data.suiteId !== 'string') throw new Error(localized(locale, 'This is not a valid QA report.', '유효한 QA 리포트가 아닙니다.'));
        return data as { suiteHash: string; suiteId: string; target: { name: string; url: string }; cases: { id: string; status: string }[] };
      };
      const before = await load(arg), after = await load(second);
      const comparable = before.suiteHash === after.suiteHash && before.target.url === after.target.url;
      console.log(comparable ? localized(locale, 'Comparing the same suite and target (check external data state separately)', '동일 명세·대상 비교 (외부 데이터 상태는 별도 확인)') : localized(locale, 'Suite or target differs; no direct regression verdict is made.', '명세 또는 대상이 달라 직접적인 회귀 판정은 하지 않습니다.'));
      const previous = new Map(before.cases.map((c) => [c.id, c.status]));
      const current = new Map(after.cases.map((c) => [c.id, c.status]));
      for (const id of new Set([...previous.keys(), ...current.keys()])) console.log(`${safeText(id)}: ${safeText(previous.get(id) ?? localized(locale, 'not included', '미포함'))} → ${safeText(current.get(id) ?? localized(locale, 'not included', '미포함'))}`);
      return;
    }
    if (command === 'doctor') {
      const config = configSchema.parse(await readConfig(workspace));
      const keyStatus = (apiKeyEnv: string | undefined) => !apiKeyEnv
        ? localized(locale, 'key environment variable not configured', '키 환경 변수 미지정')
        : localized(locale, `${apiKeyEnv}: ${process.env[apiKeyEnv] ? 'set' : 'missing'}`, `${apiKeyEnv}: ${process.env[apiKeyEnv] ? '설정됨' : '누락'}`);
      for (const pkg of ['e2e', '@e2e-dev/web', 'playwright']) {
        console.log(`${pkg}: ${await installedVersion(pkg, locale)}`);
      }
      const hasChromium = await chromiumInstalled();
      console.log(localized(locale, `Node: ${process.version}\nChromium: ${hasChromium ? 'installed' : 'missing (flow-qa browser install)'}\nTargets: ${Object.keys(config.targets).join(', ') || 'none'}\nPlanner model: ${config.planner ? 'configured' : 'not configured (prompt handoff available)'}\nAgent model: ${config.agent ? 'configured' : 'not configured (deterministic tests available)'}`, `Node: ${process.version}\nChromium: ${hasChromium ? '설치됨' : '미설치 (flow-qa browser install)'}\n대상: ${Object.keys(config.targets).join(', ') || '없음'}\n설계 모델: ${config.planner ? '연결 설정됨' : '미연결 (프롬프트 전달 가능)'}\n실행 모델: ${config.agent ? '연결 설정됨' : '미연결 (고정 조작 테스트 가능)'}`));
      if (config.planner) console.log(localized(locale, `Planner API key: ${keyStatus(config.planner.apiKeyEnv)}`, `설계 모델 API 키: ${keyStatus(config.planner.apiKeyEnv)}`));
      if (config.agent) console.log(localized(locale, `Agent API key: ${keyStatus(config.agent.apiKeyEnv)}`, `실행 모델 API 키: ${keyStatus(config.agent.apiKeyEnv)}`));
      return;
    }
    throw new Error(localized(locale, `Unknown command: ${command}`, `알 수 없는 명령: ${command}`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Flow QA: ${safeText(localizeProductMessage(message, locale))}`); process.exitCode = 2;
  }
}
