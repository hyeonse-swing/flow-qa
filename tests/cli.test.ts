import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwrightInstallInvocation } from '../src/cli.ts';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/flow-qa.mjs', import.meta.url));
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
    const output = (await qa('compare', `.flowqa/runs/${runId}`, `.flowqa/runs/${runId}`)).stdout;
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
    assert.match(doctor.stdout, /@e2e-dev\/mobile: 0\.11\.0/);
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
