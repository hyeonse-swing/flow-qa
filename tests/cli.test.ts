import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, rename, symlink, utimes } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { playwrightInstallInvocation } from '../src/cli.ts';
import { failureReport, normalizeReport1 } from '../src/report.ts';
import type { Suite } from '../src/schema.ts';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/flow-qa.mjs', import.meta.url));

test('reruns lists only direct saved children in UI history order and prints reusable paths', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'flow-qa-reruns-cli-'));
  const qa = (...args: string[]) => exec(process.execPath, [bin, ...args, '--workspace', workspace]);
  const ids = {
    parent: '0192f3a0-0000-7000-8000-000000000001',
    older: '0192f3a0-0000-7000-8000-000000000002',
    newer: '0192f3a0-0000-7000-8000-000000000003',
    grandchild: '0192f3a0-0000-7000-8000-000000000004',
    other: '0192f3a0-0000-7000-8000-000000000005',
    broken: '0192f3a0-0000-7000-8000-000000000006',
    linked: '0192f3a0-0000-7000-8000-000000000007',
  };
  const runPath = (id: string) => join(workspace, '.flowqa', 'runs', id);
  try {
    await qa('init');
    const suite = JSON.parse(await readFile(join(workspace, 'cases/task-flow.json'), 'utf8')) as Suite;
    const save = async (id: string, parentRunId?: string, status: 'passed' | 'failed' = 'failed') => {
      const dir = runPath(id);
      await mkdir(dir, { recursive: true });
      const report = failureReport({
        suite, runId: id, ...(parentRunId ? { parentRunId } : {}), suiteHash: 'a'.repeat(64),
        target: { name: 'demo', url: 'https://example.test' },
        startedAt: '2026-11-25T00:00:00.000Z', finishedAt: '2026-11-25T00:01:00.000Z',
        blockedReasons: new Map(),
      }, status, 'Observed failure');
      await writeFile(join(dir, 'qa-report.json'), JSON.stringify(report));
      await writeFile(join(dir, 'qa-report.md'), '# Saved report\n');
      return dir;
    };
    await save(ids.parent);
    assert.match((await qa('reruns', `.flowqa/runs/${ids.parent}`, '--lang', 'en')).stdout, /No runs were prepared/);
    await save(ids.older, ids.parent);
    await save(ids.newer, ids.parent, 'passed');
    await save(ids.grandchild, ids.older);
    await save(ids.other, ids.newer);
    await mkdir(runPath(ids.broken));
    await writeFile(join(runPath(ids.broken), 'qa-report.json'), '{invalid');
    await save(ids.linked, ids.parent);
    await rm(runPath(ids.linked), { recursive: true });
    await symlink(runPath(ids.parent), runPath(ids.linked));
    await utimes(runPath(ids.older), new Date('2026-11-25T00:00:00.000Z'), new Date('2026-11-25T00:00:00.000Z'));
    await utimes(runPath(ids.newer), new Date('2026-11-25T00:01:00.000Z'), new Date('2026-11-25T00:01:00.000Z'));
    const english = (await qa('reruns', `.flowqa/runs/${ids.parent}`, '--lang', 'en')).stdout.trim().split('\n');
    assert.deepEqual(english, [
      `passed\t.flowqa/runs/${ids.newer}`,
      `failed\t.flowqa/runs/${ids.older}`,
    ]);
    assert.match((await qa('report', `.flowqa/runs/${ids.newer}`)).stdout, /Saved report/);
    assert.match((await qa('compare', `.flowqa/runs/${ids.older}`, `.flowqa/runs/${ids.newer}`)).stdout, /Comparing the same suite/);
    assert.equal((await qa('reruns', `.flowqa/runs/${ids.parent}`, '--lang', 'ko')).stdout.trim().split('\n').length, 2);
    assert.match((await qa('reruns', `.flowqa/runs/${ids.grandchild}`, '--lang', 'ko')).stdout, /재실행이 없습니다/);
    const runsRoot = join(workspace, '.flowqa', 'runs');
    await rename(runsRoot, join(workspace, 'saved-runs'));
    await symlink(join(workspace, 'saved-runs'), runsRoot);
    await assert.rejects(qa('reruns', `.flowqa/runs/${ids.parent}`), /Invalid workspace run path/);
    await rm(runsRoot);
    await rename(join(workspace, 'saved-runs'), runsRoot);
    const flowqa = join(workspace, '.flowqa');
    await rename(flowqa, join(workspace, 'saved-flowqa'));
    await symlink(join(workspace, 'saved-flowqa'), flowqa);
    await assert.rejects(qa('reruns', `.flowqa/runs/${ids.parent}`), /Invalid workspace run path/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('simultaneous CLI target and model saves keep every successful change', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'flow-qa-concurrent-config-'));
  const qa = (...args: string[]) => exec(process.execPath, [bin, ...args, '--workspace', workspace]);
  try {
    await qa('init');
    await Promise.all([
      qa('connect', 'alpha', '--url', 'https://alpha.example.com'),
      qa('connect', 'beta', '--url', 'https://beta.example.com'),
      qa('model', 'planner', '--url', 'https://planner.example.com/v1', '--model', 'planner-v1'),
      qa('model', 'agent', '--url', 'https://agent.example.com/v1', '--model', 'agent-v1'),
    ]);
    const config = JSON.parse(await readFile(join(workspace, 'flowqa.config.json'), 'utf8'));
    assert.deepEqual(Object.keys(config.targets).sort(), ['alpha', 'beta', 'demo']);
    assert.equal(config.planner.model, 'planner-v1');
    assert.equal(config.agent.model, 'agent-v1');
    assert.deepEqual((await readdir(workspace)).filter(name => name.startsWith('.flowqa-config-')), []);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
test('CLI connect canonicalizes new roots but retains old root spelling on re-registration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-qa-root-cli-'));
  const qa = (...args: string[]) => exec(process.execPath, [bin, ...args, '--workspace', dir]);
  const saved = async (name: string) => JSON.parse(await readFile(join(dir, 'flowqa.config.json'), 'utf8')).targets[name];
  try {
    await qa('init');
    await qa('connect', 'fresh', '--url', 'http://127.0.0.1:43982/');
    assert.equal((await saved('fresh')).url, 'http://127.0.0.1:43982');
    const configFile = join(dir, 'flowqa.config.json');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    config.targets.legacy = { url: 'http://127.0.0.1:43982/', description: 'Old label' };
    await writeFile(configFile, JSON.stringify(config));
    await qa('connect', 'legacy', '--url', 'http://127.0.0.1:43982');
    assert.equal((await saved('legacy')).url, 'http://127.0.0.1:43982/');
    await qa('connect', 'legacy', '--url', 'http://127.0.0.1:43982/path/');
    assert.equal((await saved('legacy')).url, 'http://127.0.0.1:43982/path/');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('saved report renders normalized results in both languages and preserves older Markdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-qa-saved-report-'));
  const run = join(dir, 'run');
  const qa = (lang: string) => exec(process.execPath, [bin, 'report', run, '--lang', lang]);
  try {
    await mkdir(run);
    const saved = '# Older saved report\n\n## Possible causes\n';
    await writeFile(join(run, 'qa-report.md'), saved);
    assert.equal((await qa('en')).stdout.trim(), saved.trim(), 'Markdown-only archive remains readable');
    const at = '2026-11-18T00:00:00.000Z';
    const suite: Suite = { schemaVersion: 'flow-qa/suite-1', id: 'suite', title: 'Suite', requirements: [{ id: 'R1', text: 'Visible' }],
      cases: [{ id: 'A', title: 'Healthy', requirementIds: ['R1'], preconditions: [], questions: [], steps: [{ type: 'assertUrl', expected: 'https://example.test/' }] }] };
    const report = normalizeReport1({ schemaVersion: 'report-1', run: {
      id: '0192f3a0-0000-7000-8000-000000000000', specVersion: '0.1', runner: { name: 'e2e', version: '0.22.0' },
      status: 'passed', exitCode: 0, startedAt: at, finishedAt: at, project: { id: 'suite' }, targets: [{ id: 'preview' }],
      results: [{ titlePath: ['[A] Healthy'], file: 'suite.e2e.ts', targetId: 'preview', kind: 'test', selected: true, status: 'passed',
        attempts: [{ index: 0, status: 'passed', startedAt: at, durationMs: 1, secondaryErrors: [], steps: [], artifacts: [] }] }],
      errors: [], summary: {}, usage: { modelTokens: 0 },
    } }, { suite, runId: '666ecb72-0b3d-41d2-8cc8-a13917b23226', suiteHash: 'a'.repeat(64),
      target: { name: 'preview', url: 'https://example.test' }, startedAt: at, finishedAt: at, rawDir: dir,
      testFile: join(dir, 'suite.e2e.ts'), blockedReasons: new Map() });
    await writeFile(join(run, 'qa-report.json'), JSON.stringify(report));
    for (const [lang, heading] of [['en', 'QA results'], ['ko', 'QA 결과']]) {
      const output = (await qa(lang!)).stdout;
      assert.match(output, new RegExp(heading!));
      assert.doesNotMatch(output, /Possible causes|가능한 원인|Older saved report/);
    }
    await writeFile(join(run, 'qa-report.json'), '{malformed');
    assert.equal((await qa('en')).stdout.trim(), saved.trim());
    await writeFile(join(run, 'qa-report.json'), JSON.stringify({ schemaVersion: 'flow-qa/report-1', status: 'passed' }));
    assert.equal((await qa('ko')).stdout.trim(), saved.trim());
    for (const invalid of [
      { ...report, suiteHash: undefined }, { ...report, suiteHash: 'bad' },
      { ...report, status: 'passed', errors: ['Runtime failed'] },
      { ...report, cases: [{ ...report.cases[0], status: 'failed' }] },
      { ...report, cases: [{ ...report.cases[0], attempts: [] }] },
      { ...report, cases: [{ ...report.cases[0], attempts: [{ ...report.cases[0]!.attempts[0], status: 'failed' }] }] },
      { ...report, selection: { caseIds: ['A'], totalCases: 2, ignored: true } },
    ]) {
      await writeFile(join(run, 'qa-report.json'), JSON.stringify(invalid));
      assert.equal((await qa('en')).stdout.trim(), saved.trim());
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI selects repeated case IDs without executing or hiding unselected cases as passes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-qa-select-cli-'));
  const qa = (...args: string[]) => exec(process.execPath, [bin, ...args, '--workspace', dir]);
  try {
    await qa('init');
    assert.match((await qa('--help')).stdout, /--case/);
    const source = JSON.parse(await readFile(join(dir, 'cases/task-flow.json'), 'utf8'));
    source.cases.forEach((item: {questions:string[]}) => { item.questions = ['Choose a test account']; });
    await writeFile(join(dir, 'cases/task-flow.json'), JSON.stringify(source));
    const runs = async () => (await readdir(join(dir, '.flowqa/runs')).catch(() => [])).filter(name => /^[a-f0-9-]{36}$/.test(name));
    for (const args of [['--case','unknown'], ['--case','TC-001','--case','TC-001'], ['--case','']]) {
      await assert.rejects(qa('run','cases/task-flow.json',...args), (error: unknown) => {
        assert.equal((error as {code:number}).code, 2); return true;
      });
    }
    assert.deepEqual(await runs(), [], 'Invalid selection creates no run directory.');
    await assert.rejects(qa('validate','cases/task-flow.json','--case','TC-001'), (error: unknown) => (error as {code:number}).code === 2);
    await assert.rejects(qa('run','cases/task-flow.json','--case','TC-003','--case','TC-001','--lang','ko'), (error: unknown) => {
      const result = error as {code:number;stdout:string};
      assert.equal(result.code, 1);
      assert.match(result.stdout, /선택 실행.*3.*2/);
      return true;
    });
    const [runId] = await runs();
    const report = JSON.parse(await readFile(join(dir, '.flowqa/runs', runId!, 'qa-report.json'), 'utf8'));
    assert.deepEqual(report.selection, {caseIds:['TC-001','TC-003'],totalCases:3});
    assert.deepEqual(report.cases.map((item: {id:string}) => item.id), ['TC-001','TC-003']);
    assert.ok(report.cases.every((item: {status:string}) => item.status === 'blocked'));
    const snapshot = JSON.parse(await readFile(join(dir, '.flowqa/runs', runId!, 'suite.json'), 'utf8'));
    assert.equal(snapshot.cases.length, 3);
    const copiedRun = join(dir, 'copied-run');
    await mkdir(copiedRun);
    await writeFile(join(copiedRun, 'qa-report.json'), JSON.stringify(report));
    for (const other of [`.flowqa/runs/${runId}`, 'copied-run']) {
      await assert.rejects(qa('compare', `.flowqa/runs/${runId}`, other), (error: unknown) => {
        const result = error as { code: number; stdout: string; stderr: string };
        assert.equal(result.code, 2);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /different runs/);
        return true;
      });
    }
    await writeFile(join(copiedRun, 'qa-report.json'), JSON.stringify({ ...report, runId: randomUUID() }));
    const output = (await qa('compare', `.flowqa/runs/${runId}`, 'copied-run')).stdout;
    assert.match(output, /omitted cases were not evaluated/);
  } finally { await rm(dir, {recursive:true,force:true}); }
});
test('CLI supports a separate workspace, prompt handoff, validation and safe generation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-qa-cli-'));
  const qa = (...args: string[]) => exec(process.execPath, [bin, ...args, '--workspace', dir]);
  try {
    await qa('init');
    await qa('connect', 'preview', '--url', 'https://example.test');
    await qa('plan', 'flows/task-flow.md', '--prompt-only');
    const prompt = await readFile(join(dir, 'planning/task-flow.prompt.md'), 'utf8');
    assert.match(prompt, /flow-qa\/suite-1/);
    assert.match(prompt, /Create and filter tasks/);
    await qa('validate', 'cases/task-flow.json');
    await qa('generate', 'cases/task-flow.json');
    const before = await readFile(join(dir, 'generated/task-flow.e2e.ts'), 'utf8');
    assert.match(before, /\[TC-001\]/);
    await assert.rejects(qa('generate', 'cases/task-flow.json'), (e: unknown) => (e as { code: number }).code === 2);
    assert.equal(await readFile(join(dir, 'generated/task-flow.e2e.ts'), 'utf8'), before);
    await assert.rejects(qa('does-not-exist'), (e: unknown) => (e as { code: number }).code === 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI saves only generic model metadata and rejects removed provider options', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-qa-model-cli-'));
  const qa = (...args: string[]) => exec(process.execPath, [bin, ...args, '--workspace', dir], { env: { ...process.env, FLOW_QA_TEST_KEY: 'fixture-secret-never-write' } });
  try {
    await qa('init');
    await qa('model', 'planner', '--url', 'https://model.example/v1', '--model', 'test-model', '--key-env', 'FLOW_QA_TEST_KEY');
    const saved = await readFile(join(dir, 'flowqa.config.json'), 'utf8');
    const planner = JSON.parse(saved).planner;
    assert.deepEqual(planner, { baseURL: 'https://model.example/v1', model: 'test-model', apiKeyEnv: 'FLOW_QA_TEST_KEY' });
    assert.doesNotMatch(saved, /fixture-secret-never-write/);
    await assert.rejects(qa('model', 'agent', '--provider', 'unsupported-provider', '--url', 'https://model.example/v1', '--model', 'test-model'), (e: unknown) => {
      assert.equal((e as { code: number }).code, 2); return true;
    });
    assert.equal(await readFile(join(dir, 'flowqa.config.json'), 'utf8'), saved);
    await assert.rejects(qa('plan', 'flows/task-flow.md', '--ask-token'), (e: unknown) => {
      assert.equal((e as { code: number }).code, 2);
      assert.doesNotMatch((e as { stderr: string }).stderr, /fixture-secret-never-write/); return true;
    });
    const doctor = await qa('doctor');
    assert.match(doctor.stdout, /playwright: [0-9]+\.[0-9]+\.[0-9]+/);
    assert.match(doctor.stdout, /Chromium: (installed|missing)/);
    assert.doesNotMatch(doctor.stdout, /\/Users\/|\/private\/|fixture-secret-never-write/);
    await assert.rejects(qa('browser', 'other'), (e: unknown) => {
      assert.equal((e as { code: number }).code, 2); return true;
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('doctor reports planner and agent API key readiness without exposing key values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-qa-doctor-cli-'));
  const qa = (env: NodeJS.ProcessEnv, ...args: string[]) => exec(process.execPath, [bin, ...args, '--workspace', dir], { env });
  const plannerKey = 'FLOW_QA_DOCTOR_PLANNER_KEY';
  const agentKey = 'FLOW_QA_DOCTOR_AGENT_KEY';
  const sentinel = 'fixture-secret-never-print';
  const baseEnv: NodeJS.ProcessEnv = { ...process.env, FLOW_QA_LANG: '' };
  delete baseEnv[plannerKey];
  delete baseEnv[agentKey];
  try {
    await qa(baseEnv, 'init');
    for (const lang of ['en', 'ko']) {
      const { stdout } = await qa(baseEnv, 'doctor', '--lang', lang);
      assert.match(stdout, lang === 'en' ? /Planner model: not configured \(prompt handoff available\)/ : /설계 모델: 미연결 \(프롬프트 전달 가능\)/);
      assert.match(stdout, lang === 'en' ? /Agent model: not configured \(deterministic tests available\)/ : /실행 모델: 미연결 \(고정 조작 테스트 가능\)/);
      assert.doesNotMatch(stdout, /API key:|API 키:/);
    }
    for (const [role, key] of [['planner', plannerKey], ['agent', agentKey]]) {
      await qa(baseEnv, 'model', role!, '--url', 'https://model.example/v1', '--model', 'test-model', '--key-env', key!);
    }
    for (const [env, enState, koState] of [
      [{ ...baseEnv, [plannerKey]: sentinel, [agentKey]: sentinel }, 'set', '설정됨'],
      [baseEnv, 'missing', '누락'],
      [{ ...baseEnv, [plannerKey]: '', [agentKey]: '' }, 'missing', '누락'],
    ] as const) {
      for (const lang of ['en', 'ko']) {
        const { stdout, stderr } = await qa(env, 'doctor', '--lang', lang);
        assert.match(stdout, /playwright: [0-9]+\.[0-9]+\.[0-9]+/);
        assert.match(stdout, lang === 'en' ? /Chromium: (installed|missing)/ : /Chromium: (설치됨|미설치)/);
        const lines = lang === 'en'
          ? [`Planner API key: ${plannerKey}: ${enState}`, `Agent API key: ${agentKey}: ${enState}`]
          : [`설계 모델 API 키: ${plannerKey}: ${koState}`, `실행 모델 API 키: ${agentKey}: ${koState}`];
        for (const line of lines) assert.ok(stdout.split('\n').includes(line), `Missing doctor line: ${line}`);
        assert.doesNotMatch(stdout + stderr, /fixture-secret-never-print/);
      }
    }
    for (const role of ['planner', 'agent']) {
      await qa(baseEnv, 'model', role, '--url', 'https://model.example/v1', '--model', 'test-model');
    }
    for (const lang of ['en', 'ko']) {
      const { stdout } = await qa(baseEnv, 'doctor', '--lang', lang);
      const lines = lang === 'en'
        ? ['Planner API key: key environment variable not configured', 'Agent API key: key environment variable not configured']
        : ['설계 모델 API 키: 키 환경 변수 미지정', '실행 모델 API 키: 키 환경 변수 미지정'];
      for (const line of lines) assert.ok(stdout.split('\n').includes(line), `Missing doctor line: ${line}`);
      assert.doesNotMatch(stdout, /fixture-secret-never-print/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('browser installer uses the installed Playwright CLI and opts into system dependencies explicitly', () => {
  const normal = playwrightInstallInvocation();
  assert.equal(normal.command, process.execPath);
  assert.match(normal.args[0]!, /playwright\/cli\.js$/);
  assert.deepEqual(normal.args.slice(1), ['install', 'chromium']);
  const withDeps = playwrightInstallInvocation(true);
  assert.equal(withDeps.command, process.execPath);
  assert.deepEqual(withDeps.args, [...normal.args, '--with-deps']);
});

test('CLI forwards UI options to the local entrypoint', async () => {
  const help = await exec(process.execPath, [bin, 'ui', '--help']);
  assert.match(help.stdout, /Flow QA UI/);
  assert.match(help.stdout, /flow-qa ui --demo/);
  await assert.rejects(exec(process.execPath, [bin, 'ui', '--port', 'invalid']), (error: unknown) => {
    assert.equal((error as { code: number }).code, 1);
    assert.match((error as { stderr: string }).stderr, /Port must/);
    return true;
  });
});

test('CLI defaults to English, supports Korean, and keeps generated example content in English', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-qa-lang-cli-'));
  const qa = (...args: string[]) => exec(process.execPath, [bin, ...args, '--workspace', dir], { env: { ...process.env, FLOW_QA_LANG: '' } });
  try {
    const english = await qa('init');
    assert.match(english.stdout, /Workspace: .*\nCreated:/);
    assert.match(await readFile(join(dir, 'flows/task-flow.md'), 'utf8'), /Task title/);
    const korean = await qa('validate', 'cases/task-flow.json', '--lang', 'ko');
    assert.match(korean.stdout, /3개 케이스 유효/);
    const englishAgain = await exec(process.execPath, [bin, 'validate', 'cases/task-flow.json', '--workspace', dir],
      { env: { ...process.env, FLOW_QA_LANG: 'ko' } });
    assert.match(englishAgain.stdout, /3개 케이스 유효/);
    const override = await exec(process.execPath, [bin, 'validate', 'cases/task-flow.json', '--workspace', dir, '--lang', 'en'],
      { env: { ...process.env, FLOW_QA_LANG: 'ko' } });
    assert.match(override.stdout, /3 valid cases/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI authors native cases before target setup and saves user-selected iOS and Android apps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-qa-mobile-cli-'));
  const qa = (...args: string[]) => exec(process.execPath, [bin, ...args, '--workspace', dir], { env: { ...process.env, FLOW_QA_LANG: '' } });
  try {
    await qa('init');
    await qa('plan', 'flows/task-flow.md', '--platform', 'mobile', '--prompt-only');
    assert.match(await readFile(join(dir, 'planning/task-flow.prompt.md'), 'utf8'), /platform: "mobile"/);
    const nativeSuite = { schemaVersion: 'flow-qa/suite-1', platform: 'mobile', id: 'mobile-example', title: 'Native example',
      requirements: [{ id: 'R1', text: 'Ready is visible after launch.' }],
      cases: [{ id: 'C1', title: 'Launch', requirementIds: ['R1'], steps: [
        { type: 'launchApp' }, { type: 'assertVisible', locator: { by: 'text', value: 'Ready' } },
      ] }] };
    await writeFile(join(dir, 'cases/mobile-example.json'), JSON.stringify(nativeSuite));
    await qa('validate', 'cases/mobile-example.json');
    await qa('generate', 'cases/mobile-example.json');
    const script = await readFile(join(dir, 'generated/mobile-example.e2e.ts'), 'utf8');
    assert.match(script, /@e2e-dev\/mobile/);
    assert.match(script, /app\.open\(\)/);
    assert.doesNotMatch(script, /@e2e-dev\/web|browser/);
    await qa('connect', 'ios-test', '--platform', 'ios', '--bundle-id', 'com.example.qa', '--device', 'QA iPhone');
    await qa('connect', 'android-test', '--platform', 'android', '--bundle-id', 'com.example.qa', '--device', 'emulator-5554');
    await qa('connect', 'settings-test', '--platform', 'android', '--bundle-id', 'com.android.settings', '--device', 'emulator-5580');
    await qa('generate', 'cases/mobile-example.json', '--target', 'settings-test', '--out', 'generated/settings.e2e.ts');
    assert.match(await readFile(join(dir, 'generated/settings.e2e.ts'), 'utf8'), /device\.openApp\("com\.android\.settings"\)/);
    await qa('generate', 'cases/mobile-example.json', '--target', 'ios-test', '--out', 'generated/ios.e2e.ts');
    assert.match(await readFile(join(dir, 'generated/ios.e2e.ts'), 'utf8'), /app\.open\(\)/);
    await assert.rejects(qa('generate', 'cases/mobile-example.json', '--target', 'absent', '--out', 'generated/absent.e2e.ts'));
    const saved = await readFile(join(dir, 'flowqa.config.json'), 'utf8');
    const targets = JSON.parse(saved).targets;
    assert.deepEqual(targets['ios-test'], { kind: 'mobile', platform: 'ios', bundleId: 'com.example.qa', device: 'QA iPhone', description: '' });
    assert.equal(targets['android-test'].device, 'emulator-5554');
    for (const args of [
      ['connect', 'bad', '--platform', 'ios', '--bundle-id', 'com.example.qa'],
      ['connect', 'bad', '--platform', 'ios', '--bundle-id', 'com.example.qa', '--device', 'QA', '--url', 'https://example.test'],
      ['connect', 'bad', '--url', 'https://example.test', '--device', 'QA'],
      ['plan', 'flows/task-flow.md', '--platform', 'ios'],
    ]) await assert.rejects(qa(...args), (error: unknown) => (error as { code: number }).code === 2);
    assert.equal(await readFile(join(dir, 'flowqa.config.json'), 'utf8'), saved);
    const doctor = await qa('doctor', '--lang', 'ko');
    assert.match(doctor.stdout, /@e2e-dev\/mobile: 0\.12\.5/);
    assert.match(doctor.stdout, /모바일 대상 ios-test/);
    assert.match(doctor.stdout, /앱을 설치하거나 실행하지 않습니다/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI report comparison distinguishes mobile device and app identities', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-qa-mobile-compare-'));
  const qa = (...args: string[]) => exec(process.execPath, [bin, ...args, '--workspace', dir], { env: { ...process.env, FLOW_QA_LANG: '' } });
  try {
    const target = { name: 'qa', kind: 'mobile', platform: 'ios', bundleId: 'com.example.qa', device: 'QA iPhone' };
    const report = { suiteHash: 'a'.repeat(64), suiteId: 'mobile-suite', target, cases: [{ id: 'C1', status: 'passed' }] };
    for (const [name, currentTarget] of [['before', target], ['same', target], ['device', { ...target, device: 'Other iPhone' }], ['app', { ...target, bundleId: 'com.example.other' }]] as const) {
      await mkdir(join(dir, name));
      await writeFile(join(dir, name, 'qa-report.json'), JSON.stringify({ ...report, target: currentTarget }));
    }
    assert.match((await qa('compare', 'before', 'same')).stdout, /Comparing the same suite, target and case selection/);
    for (const changed of ['device', 'app']) assert.match((await qa('compare', 'before', changed)).stdout, /Suite, target or case selection differs/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI compares archived reports whose bare roots differ only by one slash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-qa-root-compare-'));
  const qa = (...args: string[]) => exec(process.execPath, [bin, ...args, '--workspace', dir]);
  const report = { suiteHash: 'a'.repeat(64), suiteId: 'suite', cases: [{ id: 'C1', status: 'passed' }] };
  try {
    for (const [name, url] of [['before', 'http://127.0.0.1:43982'], ['after', 'http://127.0.0.1:43982/'], ['other', 'http://127.0.0.1:43982//']]) {
      await mkdir(join(dir, name!));
      await writeFile(join(dir, name!, 'qa-report.json'), JSON.stringify({ ...report, target: { name: 'site', url } }));
    }
    assert.match((await qa('compare', 'before', 'after')).stdout, /Comparing the same suite, target and case selection/);
    assert.match((await qa('compare', 'before', 'other')).stdout, /Suite, target or case selection differs/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('CLI compare shows authored step evidence when both saved runs contain verified links', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-qa-step-cli-'));
  const qa = (...args: string[]) => exec(process.execPath, [bin, ...args, '--workspace', dir], { env: { ...process.env, FLOW_QA_LANG: '' } });
  const definedSteps = [{ type: 'assertText' }, { type: 'assertText' }, { type: 'assertVisible' }];
  const report = {
    suiteHash: 'a'.repeat(64), suiteId: 'suite',
    target: { name: 'site', url: 'http://127.0.0.1:43982' },
  };
  try {
    for (const [name, status, states] of [
      ['before', 'passed', ['passed', 'passed', 'passed']],
      ['after', 'failed', ['passed', 'failed']],
    ] as const) {
      await mkdir(join(dir, name));
      await writeFile(join(dir, name, 'qa-report.json'), JSON.stringify({
        ...report,
        cases: [{ id: 'C1', status, definedSteps, attempts: [{
          index: 0, status, steps: states.map((stepStatus, sourceStepIndex) => ({
            api: 'assert', label: 'same assertion', status: stepStatus, sourceStepIndex,
          })),
        }] }],
      }));
    }
    const english = (await qa('compare', 'before', 'after')).stdout;
    assert.match(english, /C1: passed → failed/);
    assert.match(english, /Last common passed step: 1; first differing step: 2/);
    const korean = (await qa('compare', 'before', 'after', '--lang', 'ko')).stdout;
    assert.match(korean, /마지막 공통 성공 단계: 1, 첫 결과 차이 단계: 2/);
    const old = JSON.parse(await readFile(join(dir, 'before', 'qa-report.json'), 'utf8'));
    delete old.cases[0].definedSteps;
    await writeFile(join(dir, 'before', 'qa-report.json'), JSON.stringify(old));
    const legacy = (await qa('compare', 'before', 'after')).stdout;
    assert.match(legacy, /C1: passed → failed/);
    assert.doesNotMatch(legacy, /first differing step/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('CLI compare rejects an unknown archived case status instead of reporting a transition', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-qa-invalid-compare-'));
  const qa = (...args: string[]) => exec(process.execPath, [bin, ...args, '--workspace', dir]);
  try {
    const report = { suiteHash: 'a'.repeat(64), suiteId: 'suite', target: { name: 'site', url: 'http://127.0.0.1:43982' }, cases: [{ id: 'C1', status: 'passed' }] };
    for (const name of ['before', 'after']) {
      await mkdir(join(dir, name));
      await writeFile(join(dir, name, 'qa-report.json'), JSON.stringify(name === 'before'
        ? { ...report, cases: [{ id: 'C1', status: 'unknown' }] } : report));
    }
    await assert.rejects(qa('compare', 'before', 'after'), (error: unknown) => {
      const result = error as { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 2);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /not a valid QA report/);
      return true;
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
