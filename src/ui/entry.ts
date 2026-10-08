import { lstat, mkdir, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { startUIServer } from './server.ts';
import { startDemo } from '../../examples/demo/server.ts';
import { CONFIG_FILE, initWorkspace, writeJSON } from '../workspace.ts';
import { configSchema } from '../schema.ts';
import { localeFromEnv, localized, type Locale } from '../i18n.ts';

class StartupError extends Error {}

async function privateDirectory(parent: string, name: string): Promise<string> {
  const directory = join(parent, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The demo workspace must be a regular directory.');
  return directory;
}

async function start(args: string[], locale: Locale): Promise<void> {
  const { values } = parseArgs({ args, options: {
    workspace: { type: 'string' }, port: { type: 'string' },
    demo: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    lang: { type: 'string' },
  } });
  if (values.lang && values.lang !== 'en' && values.lang !== 'ko') throw new StartupError(localized(locale, 'Unsupported language. Use en or ko.', '지원하지 않는 언어입니다. en 또는 ko를 사용하세요.'));
  if (values.help) {
    console.log(localized(locale,
      'Flow QA UI\n\nflow-qa ui [--workspace <directory>] [--port 4310] [--lang en|ko]\nflow-qa ui --demo [--port 4310] [--lang en|ko]\n\n--demo starts a separate local demo app and uses the .flowqa/ui-demo-en workspace.',
      'Flow QA UI\n\nflow-qa ui [--workspace <directory>] [--port 4310] [--lang en|ko]\nflow-qa ui --demo [--port 4310] [--lang en|ko]\n\n--demo는 별도 로컬 데모 앱과 .flowqa/ui-demo-en 작업 공간을 사용합니다.'));
    return;
  }
  const port = Number(values.port ?? 4310);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new StartupError(localized(locale, 'Port must be an integer from 0 to 65535. Example: flow-qa ui --port 4311', '포트는 0~65535 사이 정수여야 합니다. 예: flow-qa ui --port 4311'));
  if (values.demo && values.workspace) throw new StartupError(localized(locale, '--demo and --workspace cannot be used together.', '--demo와 --workspace는 함께 사용할 수 없습니다.'));
  let workspace: string;
  try { workspace = await realpath(resolve(values.workspace ?? '.')); }
  catch { throw new StartupError(localized(locale, 'Workspace directory not found. Run flow-qa init /path/to/my-qa first, then pass --workspace.', '작업 공간 디렉터리를 찾을 수 없습니다. 먼저 flow-qa init /path/to/my-qa로 준비한 뒤 --workspace로 지정하세요.')); }
  let demo: Awaited<ReturnType<typeof startDemo>> | undefined;
  let ui: Awaited<ReturnType<typeof startUIServer>> | undefined;
  try {
    if (values.demo) {
      const privateRoot = await privateDirectory(workspace, '.flowqa');
      workspace = await privateDirectory(privateRoot, 'ui-demo-en');
      await initWorkspace(workspace);
      demo = await startDemo(0);
      const configPath = join(workspace, CONFIG_FILE);
      const configInfo = await lstat(configPath);
      if (!configInfo.isFile() || configInfo.isSymbolicLink()) throw new Error('The demo configuration must be a regular file.');
      await writeJSON(configPath, configSchema.parse({
        schemaVersion: 'flow-qa/config-1',
        targets: { demo: { url: demo.url, description: 'Local task example · temporary data' } },
        timeoutMs: 15000, retries: 0,
      }));
    }
    if (!values.demo) {
      try { await lstat(join(workspace, CONFIG_FILE)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new StartupError(localized(locale, 'flowqa.config.json is missing. Run flow-qa init /path/to/my-qa or start the local example with flow-qa ui --demo.', 'flowqa.config.json이 없습니다. flow-qa init /path/to/my-qa로 작업 공간을 준비하거나 flow-qa ui --demo로 로컬 예제를 시작하세요.'));
        throw error;
      }
    }
    ui = await startUIServer({ workspace, port });
    console.log(localized(locale, `Flow QA: ${ui.url}\nWorkspace: ${workspace}`, `Flow QA: ${ui.url}\n작업 공간: ${workspace}`));
    if (demo) console.log(localized(locale, `Local demo app: ${demo.url}\nOpen the example in the case library, review it, then run it in a real browser. No model call is made.`, `로컬 데모 앱: ${demo.url}\n케이스 보관함에서 예제를 열고 검토한 뒤 실제 브라우저로 실행하세요. 모델 호출은 없습니다.`));
    const shutdown = async () => {
      process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
      await ui?.close();
      await demo?.close();
    };
    const onSignal = () => { void shutdown().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  } catch (error) {
    await ui?.close();
    await demo?.close();
    throw error;
  }
}

export async function main(args: string[]): Promise<void> {
  const flag = args.find((value) => value.startsWith('--lang='))?.slice('--lang='.length);
  const index = args.indexOf('--lang');
  const requested = index >= 0 ? args[index + 1] : flag;
  const locale = requested === 'en' || requested === 'ko' ? requested : localeFromEnv();
  try { await start(args, locale); } catch (error: unknown) {
  const message = error instanceof StartupError ? error.message
    : (error as NodeJS.ErrnoException)?.code === 'EADDRINUSE' ? localized(locale, 'Port is already in use. Choose another one, such as flow-qa ui --port 4311.', '이미 사용 중인 포트입니다. flow-qa ui --port 4311처럼 다른 포트를 지정하세요.')
    : localized(locale, 'Could not read the workspace configuration or start the server. Check flowqa.config.json and file permissions. See --help for usage.', '작업 공간 설정을 읽거나 서버를 시작하지 못했습니다. flowqa.config.json의 형식과 파일 접근 권한을 확인하세요. --help로 사용법을 볼 수 있습니다.');
  console.error(`Flow QA UI: ${message}`);
  process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main(process.argv.slice(2));
