import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { runSuite } from '../src/engine.ts';
import type { Config, Suite } from '../src/schema.ts';

const config: Config = {
  schemaVersion: 'flow-qa/config-1', targets: { local: { url: 'http://127.0.0.1:1', description: '' } }, timeoutMs: 1_000, retries: 0,
};

function suite(title: string, question = true): Suite {
  return {
    schemaVersion: 'flow-qa/suite-1', id: 'sample', title: 'Sample',
    requirements: [{ id: 'R1', text: 'First requirement' }],
    cases: [{ id: 'C1', title, requirementIds: ['R1'], preconditions: [], questions: question ? ['Which user?'] : [],
      steps: question ? [{ type: 'open', path: '/' }] : [{ type: 'assertUrl', expected: 'http://127.0.0.1:1/' }] }],
  };
}

test('every invocation creates a unique run and never reuses a previous report', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-engine-'));
  const first = await runSuite({ workspace, suite: suite('question'), config, targetName: 'local' });
  writeFileSync(path.join(first.runDir, 'raw-stale-report.json'), JSON.stringify({ status: 'passed' }));
  const second = await runSuite({ workspace, suite: suite('question'), config, targetName: 'local' });
  assert.notEqual(first.runDir, second.runDir);
  assert.equal(second.report.status, 'blocked');
  assert.equal(second.report.cases[0]?.status, 'blocked');
  assert.equal(second.report.cases[0]?.attempts.length, 0);
  assert.equal(JSON.parse(readFileSync(path.join(second.runDir, 'qa-report.json'), 'utf8')).runId, second.report.runId);
  assert.match(readFileSync(path.join(second.runDir, 'suite.sha256'), 'utf8'), /^[a-f0-9]{64}\n$/);
  assert.ok(readFileSync(path.join(second.runDir, 'qa-report.md'), 'utf8').includes('blocked'));
  assert.equal(readFileSync(path.join(workspace, '.flowqa', 'runs', '.gitignore'), 'utf8'), '*\n');
});

test('missing configured model blocks only agent cases while preparing deterministic execution', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-engine-'));
  const mixed: Suite = {
    ...suite('normal'),
    cases: [
      { id: 'C1', title: 'normal', requirementIds: ['R1'], preconditions: [], questions: [], steps: [{ type: 'assertUrl', expected: 'http://127.0.0.1:1/' }] },
      { id: 'C2', title: 'agent', requirementIds: ['R1'], preconditions: [], questions: [], steps: [{ type: 'assertAgent', instruction: 'See heading' }] },
    ],
  };
  const abort = new AbortController();
  abort.abort();
  const result = await runSuite({ workspace, suite: mixed, config, targetName: 'local', signal: abort.signal });
  assert.equal(result.report.status, 'interrupted');
  assert.equal(result.report.cases[0]?.status, 'error');
  assert.equal(result.report.cases[1]?.status, 'blocked');
  const generated = readFileSync(path.join(result.runDir, 'suite.e2e.ts'), 'utf8');
  assert.match(generated, /test\.skip\("\[C2\] agent"/);
  assert.match(generated, /test\("\[C1\] normal"/);
});

test('collection/process failure still emits an error report and never marks the case passed', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-engine-'));
  // flow-qa permits an 8 KiB title, while e2e rejects a title over 512 UTF-8 bytes during collection.
  const result = await runSuite({ workspace, suite: suite('X'.repeat(513), false), config, targetName: 'local' });
  assert.equal(result.report.status, 'error');
  assert.equal(result.report.cases[0]?.status, 'error');
  assert.ok(result.report.errors.length > 0);
  assert.ok(readFileSync(path.join(result.runDir, 'qa-report.json'), 'utf8').includes('"status": "error"'));
});

test('direct runSuite rejects a stale source before launching e2e and still writes the report', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-engine-'));
  writeFileSync(path.join(workspace, 'flow.md'), 'changed');
  const stale: Suite = { ...suite('question'), source: { file: 'flow.md', sha256: '0'.repeat(64) } };
  const result = await runSuite({ workspace, suite: stale, config, targetName: 'local' });
  assert.equal(result.report.status, 'error');
  assert.match(result.report.errors.join(' '), /STALE_SUITE/);
  assert.ok(readFileSync(path.join(result.runDir, 'qa-report.json'), 'utf8').includes('STALE_SUITE'));
});

function nativeSuite(): Suite {
  return { ...suite('native'), platform: 'mobile', cases: [{ id: 'C1', title: 'native', requirementIds: ['R1'],
    preconditions: [], questions: [], steps: [{ type: 'assertVisible', locator: { by: 'text', value: 'Ready' }, visible: true }] }] };
}

const nativeConfig: Config = { ...config, targets: { phone: { kind: 'mobile', platform: 'android', bundleId: 'com.example.app', device: 'R58N123', description: '' } } };

test('suite and target platform mismatch blocks before subprocess with zero attempts', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-engine-'));
  const result = await runSuite({ workspace, suite: nativeSuite(), config, targetName: 'local' });
  assert.equal(result.report.status, 'blocked');
  assert.equal(result.report.cases[0]?.status, 'blocked');
  assert.equal(result.report.cases[0]?.attempts.length, 0);
  assert.match(result.report.cases[0]?.reason ?? '', /suite platform does not match/);
  assert.equal(existsSync(path.join(result.runDir, 'e2e.stdout.log')), false);
});

test('missing or unavailable native device blocks before subprocess with zero attempts', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-engine-'));
  const missing = { ...nativeConfig, targets: { phone: { kind: 'mobile', platform: 'android', bundleId: 'com.example.app', description: '' } } } as unknown as Config;
  const first = await runSuite({ workspace, suite: nativeSuite(), config: missing, targetName: 'phone' });
  assert.equal(first.report.status, 'blocked');
  assert.equal(first.report.cases[0]?.attempts.length, 0);
  assert.match(first.report.cases[0]?.reason ?? '', /explicit device/);
  const second = await runSuite({ workspace, suite: nativeSuite(), config: nativeConfig, targetName: 'phone', listMobileDevices: async () => [] });
  assert.equal(second.report.status, 'blocked');
  assert.equal(second.report.cases[0]?.attempts.length, 0);
  assert.deepEqual(second.report.target, { name: 'phone', kind: 'mobile', platform: 'android', bundleId: 'com.example.app', device: 'R58N123' });
  assert.equal(existsSync(path.join(second.runDir, 'e2e.stdout.log')), false);
});

test('native config binds mobile engine and agent tools to the ready physical device without launching', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'flow-qa-engine-'));
  const abort = new AbortController();
  const suiteWithAgent: Suite = { ...nativeSuite(), cases: [{ ...nativeSuite().cases[0]!, steps: [{ type: 'assertAgent', instruction: 'Ready' }] }] };
  const withAgent: Config = { ...nativeConfig, agent: { baseURL: 'https://model.example/v1', model: 'test-model' } };
  const inventory = async () => {
    abort.abort();
    return [{ platform: 'android', id: 'android:R58N123', name: 'Pixel 9', identifiers: { serial: 'R58N123' }, booted: true }];
  };
  const result = await runSuite({ workspace, suite: suiteWithAgent, config: withAgent, targetName: 'phone', signal: abort.signal, listMobileDevices: inventory });
  assert.equal(result.report.status, 'interrupted');
  assert.equal(result.report.cases[0]?.attempts.length, 0);
  assert.equal(existsSync(path.join(result.runDir, 'e2e.stdout.log')), false);
  const source = readFileSync(path.join(result.runDir, 'e2e.config.ts'), 'utf8');
  assert.match(source, /import \{ mobile \} from/);
  assert.match(source, /import \{ mobileTools \} from/);
  assert.match(source, /tools: mobileTools\(engine\)/);
  assert.match(source, /device: "Pixel 9"/);
  assert.match(source, /bundleId: "com\.example\.app"/);
  assert.match(source, new RegExp(`session: "${result.report.runId}"`));
  assert.doesNotMatch(source, /@e2e-dev\/web|web\(\)|url:/);

  const typed = `import type { E2EConfig } from 'e2e';\n${source
    .replaceAll(import.meta.resolve('@e2e-dev/mobile/tools'), '@e2e-dev/mobile/tools')
    .replaceAll(import.meta.resolve('@e2e-dev/mobile'), '@e2e-dev/mobile')
    .replaceAll(import.meta.resolve('@ai-sdk/openai-compatible'), '@ai-sdk/openai-compatible')
    .replace(/};\s*$/, '} satisfies E2EConfig;')}`;
  const fileName = path.resolve('tests/.generated-mobile-config.ts');
  const compilerOptions: ts.CompilerOptions = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2023, strict: true, skipLibCheck: true, noEmit: true, types: ['node'] };
  const host = ts.createCompilerHost(compilerOptions);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => name === fileName
    ? ts.createSourceFile(name, typed, languageVersion, true)
    : original(name, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([fileName], compilerOptions, host);
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});
