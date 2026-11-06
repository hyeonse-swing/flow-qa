import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPreferenceScript } from '@hyeonse/design-system/preferences';
import { PlannerError } from '../src/planner.ts';
import { failureReport, renderMarkdown, type QAReport } from '../src/report.ts';
import { selectCases } from '../src/case-selection.ts';
import { targetFingerprint } from '../src/targets.ts';
import type { Config, Suite } from '../src/schema.ts';
import { startUIServer, type UIServerHandle } from '../src/ui/server.ts';
import { initWorkspace, readConfig, readSuite, sha256 } from '../src/workspace.ts';

async function fixture(options: Parameters<typeof startUIServer>[0] = { workspace: '' }) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'flowqa-ui-'));
  await initWorkspace(workspace);
  const server = await startUIServer({ ...options, workspace, port: 0 });
  const state = await (await fetch(`${server.url}/api/state`)).json() as { csrfToken: string };
  return {
    workspace, server, token: state.csrfToken,
    async close() { await server.close(); await rm(workspace, { recursive: true, force: true }); },
  };
}
async function post(server: UIServerHandle, token: string, route: string, value: unknown) {
  return fetch(`${server.url}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-flowqa-token': token }, body: JSON.stringify(value),
  });
}
async function statusWithHost(url: string, host: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const client = request(url, { headers: { Host: host } }, (response) => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    client.once('error', reject); client.end();
  });
}
async function state(server: UIServerHandle) {
  return (await (await fetch(`${server.url}/api/state`)).json()) as {
    csrfToken: string; suites: { file: string; id: string; caseCount: number }[];
    targets: { name: string; url?: string; kind?: 'mobile'; platform?: 'ios' | 'android'; bundleId?: string; device?: string; description: string; targetFingerprint: string }[];
    runs: { runId: string; status: string; caseCount: number; passedCount: number }[];
    active: { id: string; kind: 'plan' | 'run'; status: string } | null;
    models: { planner: { configured: boolean; kind: string; keyReady: boolean }; agent: { configured: boolean; kind: string; keyReady: boolean } };
    runtime: { browserInstalled: boolean; browserInstallCommand: string };
    lastRunId?: string; lastError?: string;
  };
}
async function reviewedSuiteHash(server: UIServerHandle, file = 'task-flow.json'): Promise<string> {
  const response = await fetch(`${server.url}/api/suite?file=${encodeURIComponent(file)}`);
  assert.equal(response.status, 200);
  return (await response.json() as { suiteHash: string }).suiteHash;
}

test('loopback API rejects foreign host/origin/site, missing CSRF and oversized JSON', async () => {
  const app = await fixture();
  try {
    const valid = await fetch(`${app.server.url}/api/state`);
    assert.equal(valid.status, 200);
    assert.equal(valid.headers.get('cache-control'), 'no-store');
    assert.equal(valid.headers.get('access-control-allow-origin'), null);
    assert.match(valid.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal((await state(app.server)).suites[0]?.file, 'task-flow.json');
    assert.equal((await stat(path.join(app.workspace, '.flowqa'))).mode & 0o777, 0o700);
    assert.equal(await readFile(path.join(app.workspace, '.flowqa', '.gitignore'), 'utf8'), '*\n');

    assert.equal(await statusWithHost(`${app.server.url}/api/state`, 'evil.test'), 403);
    assert.equal((await fetch(`${app.server.url}/api/state`, { headers: { origin: 'https://evil.test' } })).status, 403);
    assert.equal((await fetch(`${app.server.url}/api/state`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(`${app.server.url}/api/state`, { headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
    assert.equal((await fetch(`${app.server.url}/api/state`, { headers: { origin: app.server.url, 'sec-fetch-site': 'same-origin' } })).status, 200);
    assert.equal((await fetch(`${app.server.url}/api/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flow: 'hello' }) })).status, 403);
    assert.equal((await post(app.server, 'wrong', '/api/prompt', { flow: 'hello' })).status, 403);
    assert.equal((await post(app.server, app.token, '/api/prompt', { flow: 'x'.repeat(260_000) })).status, 413);
    assert.equal((await fetch(`${app.server.url}/../flowqa.config.json`)).status, 404);
  } finally { await app.close(); }
});

test('only named design-system assets and local fonts are served with exact bytes and strict CSP', async () => {
  const app = await fixture();
  try {
    const assets = [
      ['/design-system/tokens.css', fileURLToPath(import.meta.resolve('@hyeonse/design-system/tokens.css')), 'text/css; charset=utf-8'],
      ['/design-system/components.css', fileURLToPath(import.meta.resolve('@hyeonse/design-system/components.css')), 'text/css; charset=utf-8'],
      ['/design-system/preferences.js', fileURLToPath(import.meta.resolve('@hyeonse/design-system/preferences')), 'application/javascript; charset=utf-8'],
      ['/display.js', path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/ui/public/display.js'), 'application/javascript; charset=utf-8'],
      ['/i18n.js', path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/ui/public/i18n.js'), 'application/javascript; charset=utf-8'],
      ['/fonts/dm-sans.woff2', path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/ui/public/fonts/dm-sans.woff2'), 'font/woff2'],
      ['/fonts/noto-kr-subset.woff2', path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/ui/public/fonts/noto-kr-subset.woff2'), 'font/woff2'],
    ] as const;
    for (const [route, file, mime] of assets) {
      const response = await fetch(`${app.server.url}${route}`);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers.get('content-type'), mime, route);
      assert.equal(response.headers.get('cache-control'), 'no-store', route);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(file), route);
    }
    const init = await fetch(`${app.server.url}/design-system/init.js`);
    assert.equal(init.status, 200);
    assert.equal(init.headers.get('content-type'), 'application/javascript; charset=utf-8');
    assert.equal(await init.text(), createPreferenceScript('flowqa-display-preferences'));
    const csp = init.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'self'/);
    assert.match(csp, /font-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    for (const route of ['/design-system/package.json', '/design-system/dist/preferences.js', '/fonts/missing.woff2', '/node_modules/@hyeonse/design-system/package.json', '/src/ui/server.ts']) {
      assert.equal((await fetch(`${app.server.url}${route}`)).status, 404, route);
    }
  } finally { await app.close(); }
});

test('runtime readiness is a boolean with a fixed install command and no executable path', async () => {
  for (const installed of [false, true]) {
    const app = await fixture({ workspace: '', runtime: () => installed });
    try {
      const current = await state(app.server);
      assert.deepEqual(current.runtime, { browserInstalled: installed, browserInstallCommand: 'flow-qa browser install' });
      assert.equal(JSON.stringify(current.runtime).includes('playwright-browsers'), false);
    } finally { await app.close(); }
  }
});

test('schema failures expose bounded field paths without user values', async () => {
  const app = await fixture();
  try {
    const suite = await readSuite(path.join(app.workspace, 'cases', 'task-flow.json'));
    const malformed = { ...suite, cases: suite.cases.map((item, index) => index === 0 ? { ...item, title: '', SECRET_INPUT_FIELD: 'private-value' } : item) };
    const response = await post(app.server, app.token, '/api/compile', { suite: malformed });
    assert.equal(response.status, 400);
    const body = await response.json() as { error: string; issues: { path: string; message: string }[] };
    assert.ok(body.issues.length >= 1 && body.issues.length <= 8);
    assert.ok(body.issues.some((issue) => issue.path === '$.suite.cases[0].title'));
    assert.equal(JSON.stringify(body).includes('SECRET_INPUT_FIELD'), false);
    assert.equal(JSON.stringify(body).includes('private-value'), false);
  } finally { await app.close(); }
});

test('concurrent API requests localize product guidance without changing status or issue paths', async () => {
  const app = await fixture();
  try {
    const suite = await readSuite(path.join(app.workspace, 'cases', 'task-flow.json'));
    const malformed = { ...suite, cases: suite.cases.map((item, index) => index === 0 ? { ...item, title: '' } : item) };
    const submit = (language: string) => fetch(`${app.server.url}/api/compile`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-flowqa-token': app.token, 'accept-language': language },
      body: JSON.stringify({ suite: malformed }),
    });
    const responses = await Promise.all([submit('en'), submit('ko-KR, en;q=0.5'), submit('en')]);
    assert.deepEqual(responses.map((response) => response.status), [400, 400, 400]);
    const bodies = await Promise.all(responses.map((response) => response.json() as Promise<{ error: string; issues: { path: string; message: string }[] }>));
    const english = bodies[0]!;
    const korean = bodies[1]!;
    const englishAgain = bodies[2]!;
    assert.equal(english.error, 'Invalid input.');
    assert.equal(korean.error, '입력 형식이 올바르지 않습니다.');
    assert.deepEqual(englishAgain, english);
    assert.deepEqual(korean.issues.map((issue) => issue.path), english.issues.map((issue) => issue.path));
    assert.ok(english.issues.some((issue) => issue.message !== korean.issues.find((translated) => translated.path === issue.path)?.message));
  } finally { await app.close(); }
});

test('suite read, compile and save keep provenance inside regular flows and create unique files', async () => {
  const app = await fixture();
  try {
    const suite = await readSuite(path.join(app.workspace, 'cases', 'task-flow.json'));
    const response = await fetch(`${app.server.url}/api/suite?file=task-flow.json`);
    assert.equal(response.status, 200);
    const loaded = await response.json() as { suite: Suite; suiteHash: string; script: string; flow: string };
    assert.equal(loaded.suite.id, suite.id);
    assert.match(loaded.suiteHash, /^[a-f0-9]{64}$/);
    assert.match(loaded.script, /test\(/);
    assert.match(loaded.flow, /Create and filter tasks/);
    assert.equal((await fetch(`${app.server.url}/api/suite?file=..%2Fflowqa.config.json`)).status, 400);

    const malicious: Suite = { ...suite, source: { file: '../flowqa.config.json', sha256: '0'.repeat(64) } };
    assert.equal((await post(app.server, app.token, '/api/compile', { suite: malicious })).status, 400);
    assert.equal((await post(app.server, app.token, '/api/save', { suite: malicious })).status, 400);
    assert.equal((await post(app.server, app.token, '/api/compile', { suite: { ...suite, cases: [] } })).status, 400);
    assert.equal((await post(app.server, app.token, '/api/save', { suite, flow: 'updated flow' })).status, 200);
    const saved1 = await (await post(app.server, app.token, '/api/save', { suite, flow: 'updated flow' })).json() as { file: string };
    const saved2 = await (await post(app.server, app.token, '/api/save', { suite, flow: 'updated flow' })).json() as { file: string };
    assert.notEqual(saved1.file, saved2.file);
    const savedSuite = await readSuite(path.join(app.workspace, 'cases', saved1.file));
    assert.match(savedSuite.source?.file ?? '', /^flows\/task-flow-[0-9a-f-]+\.md$/);
    assert.equal(await readFile(path.join(app.workspace, savedSuite.source!.file), 'utf8'), 'updated flow');
    assert.equal((await post(app.server, app.token, '/api/compile', { suite: savedSuite })).status, 200);
    await writeFile(path.join(app.workspace, savedSuite.source!.file), 'changed');
    assert.equal((await fetch(`${app.server.url}/api/suite?file=${encodeURIComponent(saved1.file)}`)).status, 409);
    assert.equal((await post(app.server, app.token, '/api/save', { suite: savedSuite })).status, 409);
    assert.equal((await post(app.server, app.token, '/api/compile', { suite: savedSuite })).status, 409);

    const outside = await mkdtemp(path.join(tmpdir(), 'flowqa-outside-'));
    try {
      await writeFile(path.join(outside, 'secret.md'), 'secret');
      await symlink(path.join(outside, 'secret.md'), path.join(app.workspace, 'flows', 'linked.md'));
      const linked: Suite = { ...suite, source: { file: 'flows/linked.md', sha256: '0'.repeat(64) } };
      assert.equal((await post(app.server, app.token, '/api/compile', { suite: linked })).status, 404);
      await symlink(path.join(outside, 'secret.md'), path.join(app.workspace, 'cases', 'linked.json'));
      assert.equal((await fetch(`${app.server.url}/api/suite?file=linked.json`)).status, 404);
    } finally { await rm(outside, { recursive: true, force: true }); }
  } finally { await app.close(); }
});

test('file import verifies external source bytes and prepares an unsaved copy with review questions intact', async () => {
  const app = await fixture();
  try {
    const original = await readSuite(path.join(app.workspace, 'cases/task-flow.json'));
    const flow = '  # Imported flow\r\n\r\n한국어 원본\r\n';
    const suite: Suite = { ...original, source: { file: 'flows/external.md', sha256: sha256(flow) },
      cases: original.cases.map(item => ({ ...item, questions: ['Review the expected result.'] })) };
    const filesBefore = await Promise.all(['cases', 'flows'].map(dir => readdir(path.join(app.workspace, dir))));
    const response = await post(app.server, app.token, '/api/import', { suite, flow });
    assert.equal(response.status, 200);
    const imported = await response.json() as { suite: Suite; script: string };
    const { source: _source, ...expected } = suite;
    assert.deepEqual(imported.suite, expected);
    assert.equal(imported.script.match(/test\.skip\(/g)?.length, suite.cases.length);
    assert.deepEqual(await Promise.all(['cases', 'flows'].map(dir => readdir(path.join(app.workspace, dir)))), filesBefore);

    const saved = await (await post(app.server, app.token, '/api/save', { suite: imported.suite, flow })).json() as { file: string };
    const savedSuite = await readSuite(path.join(app.workspace, 'cases', saved.file));
    assert.notEqual(savedSuite.source?.file, suite.source?.file);
    assert.equal(savedSuite.source?.sha256, sha256(flow));
    assert.equal(await readFile(path.join(app.workspace, savedSuite.source!.file), 'utf8'), flow);
    assert.deepEqual(savedSuite.cases, suite.cases);
    assert.deepEqual(await readSuite(path.join(app.workspace, 'cases/task-flow.json')), original);
  } finally { await app.close(); }
});

test('file import rejects missing or mismatched source, invalid schema, unsafe paths and excessive input', async () => {
  const app = await fixture();
  try {
    const suite = await readSuite(path.join(app.workspace, 'cases/task-flow.json'));
    assert.equal((await post(app.server, 'wrong', '/api/import', { suite })).status, 403);
    assert.equal((await post(app.server, app.token, '/api/import', { suite })).status, 400);
    const mismatch = await fetch(`${app.server.url}/api/import`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-flowqa-token': app.token, 'accept-language': 'ko',
    }, body: JSON.stringify({ suite, flow: 'changed' }) });
    assert.equal(mismatch.status, 409);
    assert.match((await mismatch.json() as { error: string }).error, /원본과 일치하지 않습니다/);
    assert.equal((await post(app.server, app.token, '/api/import', { suite: { ...suite, cases: [] } })).status, 400);
    assert.equal((await post(app.server, app.token, '/api/import', { suite: { ...suite, source: { file: '../outside.md', sha256: sha256('flow') } }, flow: 'flow' })).status, 400);
    assert.equal((await post(app.server, app.token, '/api/import', { suite, flow: 'x'.repeat(128 * 1024 + 1) })).status, 413);
    assert.equal((await post(app.server, app.token, '/api/import', { suite, flow: 'x'.repeat(256 * 1024) })).status, 413);
    assert.equal((await state(app.server)).suites.length, 1);
  } finally { await app.close(); }
});

test('file import accepts source-less JSON with or without optional Markdown', async () => {
  const app = await fixture();
  try {
    const { source: _source, ...suite } = await readSuite(path.join(app.workspace, 'cases/task-flow.json'));
    for (const body of [{ suite }, { suite, flow: '# New source\n' }]) {
      const response = await post(app.server, app.token, '/api/import', body);
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json() as { suite: Suite }).suite, suite);
    }
  } finally { await app.close(); }
});

test('settings validate schemas, persist on restart and never return API key values', async () => {
  const app = await fixture();
  const keyName = 'FLOWQA_UI_TEST_SECRET';
  process.env[keyName] = 'private-do-not-return';
  try {
    assert.equal((await post(app.server, app.token, '/api/targets', { name: 'site', url: 'https://example.com', description: 'Public test site' })).status, 200);
    assert.equal((await post(app.server, app.token, '/api/targets', { name: 'bad', url: 'http://example.com' })).status, 400);
    assert.equal((await post(app.server, app.token, '/api/models', { role: 'planner', baseURL: 'https://example.com/v1', model: 'test-model', apiKeyEnv: keyName })).status, 200);
    assert.equal((await post(app.server, app.token, '/api/models', { role: 'agent', baseURL: 'https://example.com/v1', model: 'test-model', apiKey: 'secret' })).status, 400);
    assert.equal((await post(app.server, app.token, '/api/models', { role: 'agent', baseURL: 'https://example.com/v1', model: 'test-model', apiKeyEnv: 'bad-name' })).status, 400);
    const stateResponse = await fetch(`${app.server.url}/api/state`);
    const stateText = await stateResponse.text();
    assert.equal(stateText.includes('private-do-not-return'), false);
    assert.equal(JSON.parse(stateText).models.planner.keyReady, true);
    const site = (await readConfig(app.workspace)).targets.site;
    assert.equal(site && 'url' in site ? site.url : undefined, 'https://example.com');
    await app.server.close();
    const restarted = await startUIServer({ workspace: app.workspace, port: 0 });
    try {
      const newState = await state(restarted);
      assert.equal(newState.models.planner.configured, true);
      assert.equal(newState.models.planner.kind, 'openai-compatible');
      assert.equal(newState.suites.length, 1);
      assert.equal((await post(restarted, newState.csrfToken, '/api/models', { role: 'planner', clear: true })).status, 200);
      assert.equal((await state(restarted)).models.planner.configured, false);
    } finally { await restarted.close(); }
  } finally { delete process.env[keyName]; await app.close(); }
});

test('prompt and configured planner use injected adapter without trusting model source metadata', async () => {
  let calls = 0;
  const app = await fixture({ workspace: '', plan: async (_flow, _model, _options) => {
    calls++;
    const suite = await readSuite(path.join(app.workspace, 'cases', 'task-flow.json'));
    return { ...suite, source: { file: '../untrusted.md', sha256: '0'.repeat(64) } };
  } });
  try {
    const prompt = await post(app.server, app.token, '/api/prompt', { flow: '# Generic flow' });
    assert.equal(prompt.status, 200);
    assert.match((await prompt.json() as { prompt: string }).prompt, /Generic flow/);
    assert.equal((await post(app.server, app.token, '/api/plan', { flow: '# Generic flow' })).status, 409);
    assert.equal(calls, 0);
    assert.equal((await post(app.server, app.token, '/api/models', { role: 'planner', baseURL: 'https://example.com/v1', model: 'test' })).status, 200);
    const planned = await post(app.server, app.token, '/api/plan', { flow: '# Generic flow' });
    assert.equal(planned.status, 200);
    const result = await planned.json() as { suite: Suite; script: string };
    assert.equal(result.suite.source, undefined);
    assert.match(result.script, /test\(/);
    assert.equal(calls, 1);
  } finally { await app.close(); }
});

test('mobile cases can be authored before a target and the selected platform reaches the planner', async () => {
  const seen: string[] = [];
  const app = await fixture({ workspace: '', plan: async (_flow, _model, options) => {
    seen.push(options?.platform ?? 'web');
    const base = await readSuite(path.join(app.workspace, 'cases', 'task-flow.json'));
    return { ...base, platform: 'mobile', cases: base.cases.map((item) => ({ ...item, steps: [
      { type: 'launchApp' as const }, { type: 'assertVisible' as const, locator: { by: 'text' as const, value: 'Ready' }, visible: true },
    ] })) };
  } });
  try {
    assert.equal((await state(app.server)).targets.some((target) => target.kind === 'mobile'), false);
    const prompt = await post(app.server, app.token, '/api/prompt', { flow: 'Open the app', platform: 'mobile' });
    assert.equal(prompt.status, 200);
    assert.match((await prompt.json() as { prompt: string }).prompt, /mobile/i);
    assert.equal((await post(app.server, app.token, '/api/models', { role: 'planner', baseURL: 'https://example.com/v1', model: 'test' })).status, 200);
    const planned = await post(app.server, app.token, '/api/plan', { flow: 'Open the app', platform: 'mobile' });
    assert.equal(planned.status, 200);
    const result = await planned.json() as { suite: Suite; script: string };
    assert.equal(result.suite.platform, 'mobile');
    assert.match(result.script, /app\.open\(\)/);
    assert.deepEqual(seen, ['mobile']);
    assert.equal((await post(app.server, app.token, '/api/compile', { suite: result.suite })).status, 200);
  } finally { await app.close(); }
});

test('native targets persist without device action and changed identity invalidates reviewed runs', async () => {
  let runs = 0;
  const app = await fixture({ workspace: '', run: async () => { runs += 1; throw new Error('No device action should occur in this test.'); } });
  try {
    const original = { name: 'personal-app', kind: 'mobile' as const, platform: 'ios' as const, bundleId: 'org.example.app', device: 'Test iPhone' };
    assert.equal((await post(app.server, app.token, '/api/targets', original)).status, 200);
    assert.equal(runs, 0);
    const first = (await state(app.server)).targets.find((target) => target.name === original.name)!;
    assert.equal(first.targetFingerprint, targetFingerprint(original));
    assert.equal(first.bundleId, original.bundleId);
    assert.equal((await readConfig(app.workspace)).targets[original.name]?.kind, 'mobile');
    const base = await readSuite(path.join(app.workspace, 'cases', 'task-flow.json'));
    const mobile = { ...base, platform: 'mobile', cases: base.cases.map((item) => ({ ...item, steps: [
      { type: 'launchApp' as const }, { type: 'assertVisible' as const, locator: { by: 'text' as const, value: 'Ready' }, visible: true },
    ] })) };
    const saved = await post(app.server, app.token, '/api/save', { suite: mobile });
    assert.equal(saved.status, 200);
    const file = (await saved.json() as { file: string }).file;
    const suiteHash = await reviewedSuiteHash(app.server, file);
    assert.equal((await post(app.server, app.token, '/api/run', { suite: file, suiteHash, targetName: original.name, targetURL: 'https://example.com' })).status, 409);
    assert.equal((await post(app.server, app.token, '/api/run', { suite: file, suiteHash, targetName: 'demo', targetFingerprint: first.targetFingerprint })).status, 409);
    assert.equal((await post(app.server, app.token, '/api/targets', { ...original, device: 'Other iPhone' })).status, 200);
    assert.equal((await post(app.server, app.token, '/api/run', { suite: file, suiteHash, targetName: original.name, targetFingerprint: first.targetFingerprint })).status, 409);
    assert.equal(runs, 0);
  } finally { await app.close(); }
});

test('plan is visible, aborts promptly, ignores a late adapter result and releases the mutation lock', async () => {
  let started = 0;
  let resolvePlan: (suite: Suite) => void = () => undefined;
  const app = await fixture({ workspace: '', plan: async () => {
    started++;
    return new Promise<Suite>((resolve) => { resolvePlan = resolve; });
  } });
  try {
    assert.equal((await post(app.server, app.token, '/api/models', { role: 'planner', baseURL: 'https://example.com/v1', model: 'test' })).status, 200);
    const pending = post(app.server, app.token, '/api/plan', { flow: '# Example flow' });
    let current = await state(app.server);
    for (let index = 0; index < 40 && (!current.active || started === 0); index++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      current = await state(app.server);
    }
    assert.equal(current.active?.kind, 'plan');
    assert.equal(current.active?.status, 'running');
    assert.equal((await post(app.server, app.token, '/api/models', { role: 'agent', clear: true })).status, 409);
    assert.equal((await post(app.server, app.token, '/api/stop', {})).status, 200);
    const stopped = await pending;
    assert.equal(stopped.status, 409);
    assert.equal((await stopped.json() as { category: string }).category, 'cancelled');
    assert.equal((await state(app.server)).active, null);
    const suite = await readSuite(path.join(app.workspace, 'cases', 'task-flow.json'));
    resolvePlan(suite);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal((await state(app.server)).active, null);
    assert.equal((await post(app.server, app.token, '/api/models', { role: 'agent', clear: true })).status, 200);
  } finally { await app.close(); }
});

test('closing the server aborts a planner that ignores its signal', async () => {
  const app = await fixture({ workspace: '', plan: async () => new Promise<Suite>(() => undefined) });
  try {
    assert.equal((await post(app.server, app.token, '/api/models', { role: 'planner', baseURL: 'https://example.com/v1', model: 'test' })).status, 200);
    const pending = post(app.server, app.token, '/api/plan', { flow: '# Example flow' });
    let current = await state(app.server);
    for (let index = 0; index < 40 && current.active?.kind !== 'plan'; index++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      current = await state(app.server);
    }
    assert.equal(current.active?.kind, 'plan');
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([app.server.close(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('server close waited for an uncooperative planner')), 1_000);
      })]);
    } finally { clearTimeout(timer); }
    assert.equal((await pending).status, 409);
  } finally { await app.close(); }
});

test('close finishes with an authenticated request whose body never completes', async () => {
  const app = await fixture();
  const socket = createConnection(Number(new URL(app.server.url).port), '127.0.0.1');
  socket.on('error', () => undefined);
  let responded = false;
  socket.on('data', () => { responded = true; });
  try {
    await once(socket, 'connect');
    const received = once(app.server.server, 'request');
    socket.write(`POST /api/prompt HTTP/1.1\r\nHost: ${new URL(app.server.url).host}\r\nContent-Type: application/json\r\nX-Flowqa-Token: ${app.token}\r\nContent-Length: 100\r\n\r\n{`);
    await received;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(responded, false);
    const closing = app.server.close();
    assert.strictEqual(app.server.close(), closing);
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([closing, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('server close waited for an incomplete request body')), 2_000);
      })]);
    } finally { clearTimeout(timeout); }
  } finally {
    socket.destroy();
    await app.close();
  }
});

test('planner failure guidance never reflects provider secrets or untrusted issue text', async () => {
  let calls = 0;
  const app = await fixture({ workspace: '', plan: async () => {
    calls++;
    if (calls === 1) throw new PlannerError('http', 'private-provider-payload', 401);
    throw new PlannerError('invalid-suite', 'private-provider-payload', undefined, [{ path: 'private-path', message: 'private-provider-payload' }]);
  } });
  try {
    assert.equal((await post(app.server, app.token, '/api/models', { role: 'planner', baseURL: 'https://example.com/v1', model: 'test' })).status, 200);
    const denied = await post(app.server, app.token, '/api/plan', { flow: '# Example flow' });
    assert.equal(denied.status, 502);
    const deniedText = await denied.text();
    assert.match(deniedText, /Check model authentication and access permissions/);
    assert.equal(deniedText.includes('private-provider-payload'), false);
    const invalidSuite = await post(app.server, app.token, '/api/plan', { flow: '# Example flow' });
    assert.equal(invalidSuite.status, 502);
    const invalidText = await invalidSuite.text();
    assert.match(invalidText, /invalid-suite/);
    assert.equal(invalidText.includes('private-provider-payload'), false);
    assert.equal(invalidText.includes('private-path'), false);
  } finally { await app.close(); }
});

test('run accepts one immutable snapshot, stop aborts it, and history/report come from disk', async () => {
  let calls = 0;
  let observedSuite: Suite | undefined;
  const app = await fixture({ workspace: '', run: async ({ workspace, suite, config, targetName, signal }) => {
    calls++;
    observedSuite = suite;
    await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
    const runId = randomUUID();
    const runDir = path.join(workspace, '.flowqa', 'runs', runId);
    await mkdir(runDir, { recursive: true });
    const report = failureReport({ suite, runId, suiteHash: 'hash', target: { name: targetName, url: 'url' in config.targets[targetName]! ? config.targets[targetName]!.url : '' },
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), blockedReasons: new Map() }, 'interrupted', 'Stopped');
    await writeFile(path.join(runDir, 'qa-report.json'), JSON.stringify(report));
    await writeFile(path.join(runDir, 'qa-report.md'), renderMarkdown(report));
    return { runDir, report };
  } });
  try {
    const suiteHash = await reviewedSuiteHash(app.server);
    const targetURL = (await state(app.server)).targets.find((target) => target.name === 'demo')!.url;
    const unsafe = await readSuite(path.join(app.workspace, 'cases', 'task-flow.json'));
    await writeFile(path.join(app.workspace, 'cases', 'unsafe.json'), JSON.stringify({ ...unsafe, source: { file: '../outside.md', sha256: '0'.repeat(64) } }));
    assert.equal((await post(app.server, app.token, '/api/run', { suite: 'unsafe.json', suiteHash, targetName: 'demo', targetURL })).status, 400);
    assert.equal((await post(app.server, app.token, '/api/run', { suite: 'task-flow.json', targetName: 'demo', targetURL })).status, 400);
    const caseFile = path.join(app.workspace, 'cases', 'task-flow.json');
    const reviewedFile = await readFile(caseFile, 'utf8');
    await writeFile(caseFile, JSON.stringify({ ...unsafe, title: 'Unreviewed edit' }));
    assert.equal((await post(app.server, app.token, '/api/run', { suite: 'task-flow.json', suiteHash, targetName: 'demo', targetURL })).status, 409);
    assert.equal(calls, 0);
    await writeFile(caseFile, reviewedFile);
    assert.equal((await post(app.server, app.token, '/api/targets', { name: 'demo', url: 'https://example.com' })).status, 200);
    assert.equal((await post(app.server, app.token, '/api/run', { suite: 'task-flow.json', suiteHash, targetName: 'demo', targetURL })).status, 409);
    assert.equal(calls, 0);
    assert.equal((await post(app.server, app.token, '/api/targets', { name: 'demo', url: targetURL })).status, 200);
    const started = await post(app.server, app.token, '/api/run', { suite: 'task-flow.json', suiteHash, targetName: 'demo', targetURL });
    assert.equal(started.status, 202);
    assert.match((await started.json() as { operationId: string }).operationId, /^[0-9a-f-]{36}$/);
    assert.equal((await state(app.server)).active?.status, 'running');
    assert.equal((await post(app.server, app.token, '/api/run', { suite: 'task-flow.json', suiteHash, targetName: 'demo', targetURL })).status, 409);
    assert.equal((await post(app.server, app.token, '/api/targets', { name: 'other', url: 'https://example.com' })).status, 409);
    assert.equal((await post(app.server, app.token, '/api/stop', {})).status, 200);
    assert.ok([null, 'stopping'].includes((await state(app.server)).active?.status ?? null));
    let current = await state(app.server);
    for (let index = 0; index < 40 && current.active; index++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      current = await state(app.server);
    }
    assert.equal(current.active, null);
    assert.equal(calls, 1);
    assert.equal(observedSuite?.id, 'task-flow');
    assert.equal(current.runs.length, 1);
    assert.equal(current.runs[0]?.status, 'interrupted');
    assert.equal(current.runs[0]?.caseCount, 3);
    assert.equal(current.runs[0]?.passedCount, 0);
    assert.equal(current.lastRunId, current.runs[0]?.runId);
    const report = await fetch(`${app.server.url}/api/report?runId=${current.lastRunId}`);
    assert.equal(report.status, 200);
    const englishReport = await report.json() as { markdown: string; report: { status: string; cases: unknown[] } };
    assert.match(englishReport.markdown, /QA results/);
    const koreanReportResponse = await fetch(`${app.server.url}/api/report?runId=${current.lastRunId}`, { headers: { 'accept-language': 'ko' } });
    assert.equal(koreanReportResponse.status, 200);
    const koreanReport = await koreanReportResponse.json() as typeof englishReport;
    assert.match(koreanReport.markdown, /QA 결과/);
    assert.deepEqual(koreanReport.report, englishReport.report);
    assert.equal((await fetch(`${app.server.url}/api/report?runId=..%2Fother`)).status, 400);

    const outside = await mkdtemp(path.join(tmpdir(), 'flowqa-report-outside-'));
    try {
      const linkedRun = randomUUID();
      await symlink(outside, path.join(app.workspace, '.flowqa', 'runs', linkedRun));
      assert.equal((await fetch(`${app.server.url}/api/report?runId=${linkedRun}`)).status, 404);
      assert.equal((await state(app.server)).runs.length, 1);
    } finally { await rm(outside, { recursive: true, force: true }); }

    await app.server.close();
    const restarted = await startUIServer({ workspace: app.workspace, port: 0 });
    try { assert.equal((await state(restarted)).runs.length, 1); }
    finally { await restarted.close(); }
  } finally { await app.close(); }
});

test('run history searches beyond state, paginates by mtime and UUID, and skips unsafe records', async () => {
  let actions = 0;
  const app = await fixture({ workspace: '', run: async () => { actions++; throw new Error('Unexpected run.'); },
    plan: async () => { actions++; throw new Error('Unexpected plan.'); } });
  const outside = await mkdtemp(path.join(tmpdir(), 'flowqa-history-outside-'));
  try {
    const suite = await readSuite(path.join(app.workspace, 'cases', 'task-flow.json'));
    const root = path.join(app.workspace, '.flowqa', 'runs');
    const baseTime = Date.UTC(2026, 9, 1);
    const statuses: QAReport['status'][] = ['passed', 'failed', 'blocked', 'error', 'interrupted'];
    const records: { id: string; mtime: number; status: QAReport['status'] }[] = [];
    const idsByIndex: string[] = [];
    const saveRun = async (id: string, index: number, status: QAReport['status'], suiteId = suite.id, targetName = 'demo') => {
      const runDir = path.join(root, id);
      await mkdir(runDir);
      const report = failureReport({ suite, runId: id, suiteHash: 'hash',
        target: { name: targetName, url: 'https://find-me.example' },
        startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:01:00.000Z',
        blockedReasons: new Map() }, status, 'Search-only error');
      report.suiteId = suiteId;
      report.cases[0]!.title = 'Search-only title';
      if (index === 0) { report.cases[0]!.status = 'flaky'; report.cases[1]!.status = 'passed'; }
      await writeFile(path.join(runDir, 'qa-report.json'), JSON.stringify(report));
      const mtime = baseTime - Math.floor(index / 2) * 1000;
      await utimes(runDir, new Date(mtime), new Date(mtime));
      return { id, mtime: (await stat(runDir)).mtimeMs, status };
    };
    for (let index = 0; index < 70; index++) {
      const id = randomUUID();
      idsByIndex.push(id);
      const status = index === 67 ? 'failed' : statuses[index % statuses.length]!;
      records.push(await saveRun(id, index, status, index === 62 ? 'archive_suite' : suite.id,
        index === 67 ? '한국 상점' : index === 68 ? 'Seoul MARKET' : 'demo'));
    }
    const invalidRun = randomUUID();
    const invalidDir = path.join(root, invalidRun);
    await mkdir(invalidDir);
    await writeFile(path.join(invalidDir, 'qa-report.json'), '{invalid json');
    await utimes(invalidDir, new Date(baseTime + 1000), new Date(baseTime + 1000));
    const incomplete = randomUUID();
    await mkdir(path.join(root, incomplete)); // Incomplete run.
    const mismatched = randomUUID();
    await mkdir(path.join(root, mismatched));
    await writeFile(path.join(root, mismatched, 'qa-report.json'), JSON.stringify({
      ...JSON.parse(await readFile(path.join(root, records[0]!.id, 'qa-report.json'), 'utf8')) as QAReport, runId: randomUUID(),
    }));
    const linkedFile = randomUUID();
    await mkdir(path.join(root, linkedFile));
    await writeFile(path.join(outside, 'qa-report.json'), await readFile(path.join(root, records[0]!.id, 'qa-report.json')));
    await symlink(path.join(outside, 'qa-report.json'), path.join(root, linkedFile, 'qa-report.json'));
    const linkedDirectory = randomUUID();
    await symlink(outside, path.join(root, linkedDirectory));
    await mkdir(path.join(root, 'not-a-run-id'));
    await writeFile(path.join(root, 'not-a-run-id', 'qa-report.json'), await readFile(path.join(root, records[0]!.id, 'qa-report.json')));

    records.sort((a, b) => b.mtime - a.mtime || (a.id < b.id ? -1 : 1));
    assert.equal(records[16]!.mtime, records[17]!.mtime, 'The first page ends inside an equal-mtime pair.');
    const expectedIds = records.map((record) => record.id);
    const reportBefore = await readFile(path.join(root, records[0]!.id, 'qa-report.json'));
    const configBefore = await readFile(path.join(app.workspace, 'flowqa.config.json'));
    const getPage = async (search = '') => {
      const response = await fetch(`${app.server.url}/api/runs${search}`);
      assert.equal(response.status, 200, search);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return await response.json() as { runs: { runId: string; suiteId: string; status: QAReport['status'];
        caseCount: number; passedCount: number; target: QAReport['target'] }[]; nextCursor: string | null };
    };

    const current = await state(app.server);
    const defaultPage = await getPage();
    assert.equal(current.runs.length, 50);
    assert.deepEqual(current.runs, defaultPage.runs);
    assert.deepEqual(defaultPage.runs.map((run) => run.runId), expectedIds.slice(0, 50));
    assert.equal(current.lastRunId, expectedIds[0]);
    assert.equal(defaultPage.runs.find((run) => run.runId === idsByIndex[0])?.passedCount, 2);
    assert.ok(defaultPage.nextCursor);

    const firstPage = await getPage('?limit=17');
    assert.deepEqual(firstPage.runs.map((run) => run.runId), expectedIds.slice(0, 17));
    const newRun = await saveRun(randomUUID(), -2, 'passed');
    assert.equal((await state(app.server)).lastRunId, newRun.id);
    const seen = [...firstPage.runs.map((run) => run.runId)];
    let cursor = firstPage.nextCursor;
    while (cursor) {
      const page = await getPage(`?limit=19&cursor=${encodeURIComponent(cursor)}`);
      seen.push(...page.runs.map((run) => run.runId));
      cursor = page.nextCursor;
    }
    assert.deepEqual(seen, expectedIds, 'A newer inserted run cannot duplicate or skip older rows.');
    assert.equal(new Set(seen).size, 70);

    const archive = await getPage('?query=%20ARCHIVE_SUITE%20&status=blocked&limit=1');
    assert.deepEqual(archive.runs.map((run) => run.runId), [idsByIndex[62]]);
    assert.equal(archive.nextCursor, null);
    const korean = await getPage(`?query=${encodeURIComponent(' 한국 ')}&status=failed`);
    assert.deepEqual(korean.runs.map((run) => run.runId), [idsByIndex[67]]);
    assert.deepEqual((await getPage('?query=%20market%20')).runs.map((run) => run.runId), [idsByIndex[68]]);
    assert.deepEqual((await getPage(`?query=${idsByIndex[69]!.toUpperCase()}`)).runs.map((run) => run.runId), [idsByIndex[69]]);
    const filteredFirst = await getPage('?query=%20DEMO%20&limit=2');
    const filteredSecond = await getPage(`?query=demo&limit=3&cursor=${filteredFirst.nextCursor}`);
    assert.deepEqual([...filteredFirst.runs, ...filteredSecond.runs].map((run) => run.runId),
      [newRun, ...records].filter((record) => ![idsByIndex[67], idsByIndex[68]].includes(record.id)).slice(0, 5).map((record) => record.id));
    for (const status of statuses) {
      const matching = await getPage(`?status=${status}`);
      assert.deepEqual(matching.runs.map((run) => run.runId), [newRun, ...records].filter((record) => record.status === status).map((record) => record.id));
      assert.equal(matching.nextCursor, null);
    }
    for (const query of ['Search-only', 'find-me.example']) {
      assert.deepEqual((await getPage(`?query=${query}`)).runs, [], 'Only suite ID, run ID and target name are searchable.');
    }
    assert.deepEqual((await getPage(`?query=${'a'.repeat(200)}`)).runs, []);

    for (const [search, error] of [
      ['?limit=0', 'Invalid run limit.'], ['?limit=51', 'Invalid run limit.'],
      ['?limit=1.5', 'Invalid run limit.'], ['?limit=01', 'Invalid run limit.'],
      ['?limit=', 'Invalid run limit.'], ['?status=unknown', 'Invalid run status.'],
      ['?limit=1&limit=51', 'Invalid input.'],
      [`?query=${'a'.repeat(201)}`, 'Run query is too long.'],
      ['?cursor=', 'Invalid run cursor.'], ['?cursor=!!!', 'Invalid run cursor.'],
      [`?cursor=${'a'.repeat(513)}`, 'Invalid run cursor.'],
      [`?cursor=${Buffer.from('{"version":1}').toString('base64url')}`, 'Invalid run cursor.'],
      [`?cursor=${firstPage.nextCursor}&query=archive_suite`, 'Invalid run cursor.'],
      [`?cursor=${firstPage.nextCursor}&status=failed`, 'Invalid run cursor.'],
    ]) {
      const response = await fetch(`${app.server.url}/api/runs${search}`);
      assert.equal(response.status, 400, search);
      assert.equal((await response.json() as { error: string }).error, error, search);
    }
    assert.equal((await fetch(`${app.server.url}/api/runs`, { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${app.server.url}/api/runs`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal(await statusWithHost(`${app.server.url}/api/runs`, 'evil.example'), 403);
    assert.equal((await post(app.server, app.token, '/api/runs', {})).status, 404);
    const oldRunId = idsByIndex[62]!;
    assert.equal(current.runs.some((run) => run.runId === oldRunId), false);
    const oldSummaryResponse = await fetch(`${app.server.url}/api/run-summary?runId=${oldRunId}`);
    assert.equal(oldSummaryResponse.status, 200);
    assert.equal(oldSummaryResponse.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await oldSummaryResponse.json(), { run: archive.runs[0] });
    for (const runId of [invalidRun, incomplete, mismatched, linkedFile, linkedDirectory, randomUUID()]) {
      assert.equal((await fetch(`${app.server.url}/api/run-summary?runId=${runId}`)).status, 404, runId);
    }
    for (const search of ['', '?runId=', `?runId=${oldRunId}&runId=${oldRunId}`, '?runId=..%2Fother']) {
      assert.equal((await fetch(`${app.server.url}/api/run-summary${search}`)).status, 400, search);
    }
    assert.equal((await fetch(`${app.server.url}/api/run-summary?runId=${oldRunId}`, { headers: { origin: 'https://evil.example' } })).status, 403);
    await rm(path.join(root, oldRunId), { recursive: true });
    assert.equal((await fetch(`${app.server.url}/api/run-summary?runId=${oldRunId}`)).status, 404);
    assert.equal(actions, 0);
    assert.deepEqual(await readFile(path.join(root, records[0]!.id, 'qa-report.json')), reportBefore);
    assert.deepEqual(await readFile(path.join(app.workspace, 'flowqa.config.json')), configBefore);
  } finally { await app.close(); await rm(outside, { recursive: true, force: true }); }
});

test('selected run API validates IDs and review gates, preserves full snapshots, and exposes partial scope', async () => {
  let observed: { suite: Suite; caseIds?: readonly string[] } | undefined;
  const captured = (): typeof observed => observed;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const app = await fixture({ workspace: '', run: async ({ workspace, suite, caseIds }) => {
    observed = { suite, caseIds };
    await gate;
    const selected = selectCases(suite, caseIds);
    const runId = randomUUID();
    const runDir = path.join(workspace, '.flowqa/runs', runId);
    await mkdir(runDir, { recursive: true });
    const report = failureReport({ suite: selected.suite, runId, suiteHash: sha256(`${JSON.stringify(suite, null, 2)}\n`),
      target: { name: 'demo', url: 'http://127.0.0.1:3000' }, startedAt: '2026-11-03T00:00:00Z', finishedAt: '2026-11-03T00:00:01Z', blockedReasons: new Map(),
      ...(selected.selection ? { selection: selected.selection } : {}) }, 'interrupted', 'Stopped');
    await writeFile(path.join(runDir, 'qa-report.json'), JSON.stringify(report));
    await writeFile(path.join(runDir, 'qa-report.md'), renderMarkdown(report));
    return { runDir, report };
  } });
  try {
    const source = await readSuite(path.join(app.workspace, 'cases/task-flow.json'));
    const originalFile = await readFile(path.join(app.workspace, 'cases/task-flow.json'), 'utf8');
    const ids = source.cases.map(item => item.id);
    const suiteHash = await reviewedSuiteHash(app.server);
    const target = (await state(app.server)).targets[0]!;
    const body = { suite: 'task-flow.json', suiteHash, targetName: target.name, targetFingerprint: target.targetFingerprint };
    for (const caseIds of [[], ['unknown'], [ids[0], ids[0]], [''], 'all', null]) {
      assert.equal((await post(app.server, app.token, '/api/run', { ...body, caseIds })).status, 400);
      assert.equal(observed, undefined);
    }
    assert.equal((await post(app.server, app.token, '/api/run', { ...body, suiteHash: '0'.repeat(64), caseIds: [ids[0]] })).status, 409);
    assert.equal((await post(app.server, app.token, '/api/run', { ...body, targetFingerprint: '0'.repeat(64), caseIds: [ids[0]] })).status, 409);
    assert.equal((await post(app.server, 'wrong', '/api/run', { ...body, caseIds: [ids[0]] })).status, 403);
    assert.equal(observed, undefined);
    assert.equal((await post(app.server, app.token, '/api/run', { ...body, caseIds: [ids[2], ids[0]] })).status, 202);
    assert.deepEqual(captured()?.caseIds, [ids[0], ids[2]]);
    assert.equal(captured()?.suite.cases.length, 3);
    await writeFile(path.join(app.workspace, 'cases/task-flow.json'), JSON.stringify({ ...source, title: 'Later edit' }));
    assert.equal(captured()?.suite.title, source.title);
    release();
    let final = await state(app.server);
    for (let i = 0; i < 100 && final.active; i++) { await new Promise(resolve => setTimeout(resolve, 10)); final = await state(app.server); }
    assert.equal(final.active, null);
    const runId = final.lastRunId!;
    const response = await fetch(`${app.server.url}/api/report?runId=${runId}`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.report.selection, { caseIds: [ids[0], ids[2]], totalCases: 3 });
    assert.deepEqual(payload.report.cases.map((item: {id:string}) => item.id), [ids[0], ids[2]]);
    assert.match(payload.markdown, /2.*3/);
    assert.deepEqual((final.runs[0] as unknown as {selection:unknown}).selection, payload.report.selection);
    const summaryResponse = await fetch(`${app.server.url}/api/run-summary?runId=${runId}`);
    assert.equal(summaryResponse.status, 200);
    assert.deepEqual((await summaryResponse.json() as { run: { selection: unknown } }).run.selection, payload.report.selection);
    const reportFile = path.join(app.workspace, '.flowqa/runs', runId, 'qa-report.json');
    await writeFile(reportFile, JSON.stringify({ ...payload.report, selection: { caseIds: [ids[0]], totalCases: 3 } }));
    assert.equal((await fetch(`${app.server.url}/api/report?runId=${runId}`)).status, 404, 'Incoherent scope must not be shown as a valid run.');
    assert.equal((await state(app.server)).runs.length, 0);
    await writeFile(path.join(app.workspace, 'cases/task-flow.json'), originalFile);
    observed = undefined;
    assert.equal((await post(app.server, app.token, '/api/run', { ...body, caseIds: [...ids].reverse() })).status, 202);
    assert.equal(captured()?.caseIds, undefined, 'Selecting every case normalizes to a legacy full run.');
  } finally { release(); await app.close(); }
});

test('rerun preparation selects only failed and errored report cases in suite order without starting or writing a run', async () => {
  let runCalls = 0;
  const app = await fixture({ workspace: '', run: async () => { runCalls++; throw new Error('Unexpected run'); } });
  try {
    const suiteFile = path.join(app.workspace, 'cases/task-flow.json');
    const suite = await readSuite(suiteFile);
    const ids = suite.cases.map((item) => item.id);
    const runId = randomUUID();
    const runDir = path.join(app.workspace, '.flowqa/runs', runId);
    await mkdir(runDir, { recursive: true });
    const report = failureReport({ suite, runId, suiteHash: sha256(`${JSON.stringify(suite, null, 2)}\n`),
      target: { name: 'demo', url: 'http://127.0.0.1:4178' }, startedAt: '2026-11-03T00:00:00Z',
      finishedAt: '2026-11-03T00:00:01Z', blockedReasons: new Map() }, 'failed', 'Test failed');
    report.cases[0]!.status = 'failed';
    report.cases[1]!.status = 'blocked';
    report.cases[2]!.status = 'error';
    const reportFile = path.join(runDir, 'qa-report.json');
    await writeFile(reportFile, JSON.stringify({ ...report, cases: [...report.cases].reverse() }));
    const before = await Promise.all([readFile(suiteFile), readFile(path.join(app.workspace, 'flows/task-flow.md')),
      readFile(path.join(app.workspace, 'flowqa.config.json')), readFile(reportFile), readdir(path.join(app.workspace, '.flowqa/runs'))]);
    const route = `/api/rerun?runId=${runId}`;
    const response = await fetch(`${app.server.url}${route}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const prepared = await response.json() as { originRunId: string; file: string; suite: Suite; suiteHash: string;
      script: string; flow: string; caseIds: string[]; targetName: string; targetFingerprint: string; targetMatches: boolean };
    assert.deepEqual(Object.keys(prepared).sort(), ['originRunId', 'file', 'suite', 'suiteHash', 'script', 'flow',
      'caseIds', 'targetName', 'targetFingerprint', 'targetMatches'].sort());
    assert.equal(prepared.originRunId, runId);
    assert.equal(prepared.file, 'task-flow.json');
    assert.deepEqual(prepared.suite, suite);
    assert.equal(prepared.suiteHash, sha256(JSON.stringify(suite)));
    assert.match(prepared.script, /test\(/);
    assert.match(prepared.flow, /Create and filter tasks/);
    assert.deepEqual(prepared.caseIds, [ids[0], ids[2]]);
    assert.equal(prepared.targetName, 'demo');
    assert.equal(prepared.targetFingerprint, targetFingerprint(report.target));
    assert.equal(prepared.targetMatches, true);
    assert.equal((await state(app.server)).active, null);
    assert.equal(runCalls, 0);
    const after = await Promise.all([readFile(suiteFile), readFile(path.join(app.workspace, 'flows/task-flow.md')),
      readFile(path.join(app.workspace, 'flowqa.config.json')), readFile(reportFile), readdir(path.join(app.workspace, '.flowqa/runs'))]);
    assert.deepEqual(after, before);

    const config = await readConfig(app.workspace);
    await writeFile(path.join(app.workspace, 'flowqa.config.json'), JSON.stringify({ ...config, targets: {
      ...config.targets, demo: { ...config.targets.demo, url: 'https://changed.example' },
    } }));
    const changedTarget = await (await fetch(`${app.server.url}${route}`)).json() as typeof prepared;
    assert.equal(changedTarget.targetMatches, false);
    assert.equal(changedTarget.targetName, prepared.targetName);
    assert.equal(changedTarget.targetFingerprint, prepared.targetFingerprint);
    await writeFile(path.join(app.workspace, 'flowqa.config.json'), JSON.stringify({ ...config, targets: {} }));
    assert.equal((await (await fetch(`${app.server.url}${route}`)).json() as typeof prepared).targetMatches, false);
    await writeFile(path.join(app.workspace, 'flowqa.config.json'), JSON.stringify(config));

    report.cases[0]!.status = 'flaky';
    report.cases[1]!.status = 'skipped';
    report.cases[2]!.status = 'failed';
    await writeFile(reportFile, JSON.stringify(report));
    assert.deepEqual((await (await fetch(`${app.server.url}${route}`)).json() as typeof prepared).caseIds, [ids[2]]);
    report.cases[2]!.status = 'blocked';
    await writeFile(reportFile, JSON.stringify(report));
    const empty = await fetch(`${app.server.url}${route}`);
    assert.equal(empty.status, 409);
    assert.equal((await empty.json() as { error: string }).error, 'No failed or errored cases are available to rerun.');
    assert.equal(runCalls, 0);
  } finally { await app.close(); }
});

test('rerun preparation rejects stale or ambiguous saved cases, invalid source, and incoherent report scope', async () => {
  const app = await fixture();
  try {
    const suiteFile = path.join(app.workspace, 'cases/task-flow.json');
    const sourceFile = path.join(app.workspace, 'flows/task-flow.md');
    const suiteBytes = await readFile(suiteFile, 'utf8');
    const sourceBytes = await readFile(sourceFile, 'utf8');
    const suite = await readSuite(suiteFile);
    const runId = randomUUID();
    const runDir = path.join(app.workspace, '.flowqa/runs', runId);
    await mkdir(runDir, { recursive: true });
    const original = failureReport({ suite, runId, suiteHash: sha256(`${JSON.stringify(suite, null, 2)}\n`),
      target: { name: 'demo', url: 'http://127.0.0.1:4178' }, startedAt: '2026-11-03T00:00:00Z',
      finishedAt: '2026-11-03T00:00:01Z', blockedReasons: new Map() }, 'failed', 'Test failed');
    const reportFile = path.join(runDir, 'qa-report.json');
    const save = async (item: QAReport) => writeFile(reportFile, JSON.stringify(item));
    const route = `${app.server.url}/api/rerun?runId=${runId}`;
    await save(original);
    assert.equal((await fetch(route)).status, 200, 'The exact pretty JSON plus newline hash is accepted.');
    await save({ ...original, suiteHash: sha256(JSON.stringify(suite)) });
    assert.equal((await fetch(route)).status, 409, 'The compact UI hash is not a report snapshot hash.');
    await save(original);
    await writeFile(suiteFile, JSON.stringify(suite));
    assert.equal((await fetch(route)).status, 200, 'JSON formatting alone does not change the parsed suite hash.');
    await writeFile(suiteFile, JSON.stringify({ ...suite, title: 'Edited later' }));
    const changedSuite = await fetch(route);
    assert.equal(changedSuite.status, 409);
    assert.equal((await changedSuite.json() as { error: string }).error,
      'The saved case file changed since this run. Review it before rerunning.');
    await writeFile(suiteFile, suiteBytes);

    await writeFile(sourceFile, 'Edited source');
    assert.equal((await fetch(route)).status, 409);
    await rm(sourceFile);
    const missingSource = await fetch(route);
    assert.equal(missingSource.status, 409);
    assert.equal((await missingSource.json() as { error: string }).error, 'The saved case file or source flow was not found.');
    await writeFile(sourceFile, sourceBytes);
    await writeFile(suiteFile, JSON.stringify({ ...suite, source: { file: '../unsafe.md', sha256: suite.source!.sha256 } }));
    assert.equal((await fetch(route)).status, 409);
    await writeFile(suiteFile, suiteBytes);

    const duplicateFile = path.join(app.workspace, 'cases/duplicate.json');
    await writeFile(duplicateFile, suiteBytes);
    const ambiguous = await fetch(route);
    assert.equal(ambiguous.status, 409);
    assert.equal((await ambiguous.json() as { error: string }).error, 'Multiple saved case files match this report.');
    await rm(duplicateFile);
    await rm(suiteFile);
    assert.equal((await fetch(route)).status, 409);
    await writeFile(suiteFile, suiteBytes);

    await save({ ...original, cases: original.cases.slice(0, 2) });
    assert.equal((await fetch(route)).status, 409, 'A full report must cover every saved case.');
    await save({ ...original, cases: [{ ...original.cases[0]!, id: 'UNKNOWN' }, ...original.cases.slice(1)] });
    assert.equal((await fetch(route)).status, 409, 'Every report case must exist in the saved suite.');
    await save({ ...original, cases: [{ ...original.cases[0]!, id: '' }, ...original.cases.slice(1)] });
    assert.equal((await fetch(route)).status, 404, 'The shared report loader rejects empty IDs.');
    await save({ ...original, cases: [original.cases[0]!, original.cases[0]!, ...original.cases.slice(2)] });
    assert.equal((await fetch(route)).status, 404, 'The shared report loader rejects duplicate IDs.');

    const selected = selectCases(suite, [suite.cases[0]!.id, suite.cases[2]!.id]);
    const partial = failureReport({ suite: selected.suite, selection: selected.selection, runId,
      suiteHash: original.suiteHash, target: original.target, startedAt: original.startedAt,
      finishedAt: original.finishedAt, blockedReasons: new Map() }, 'failed', 'Test failed');
    partial.cases[0]!.status = 'failed';
    partial.cases[1]!.status = 'passed';
    await save(partial);
    const prepared = await fetch(route);
    assert.equal(prepared.status, 200);
    assert.deepEqual((await prepared.json() as { caseIds: string[] }).caseIds, [suite.cases[0]!.id]);
    await save({ ...partial, selection: { ...partial.selection!, totalCases: 4 } });
    assert.equal((await fetch(route)).status, 409, 'Partial metadata must describe the current full suite.');
    await save({ ...partial, selection: { ...partial.selection!, caseIds: [suite.cases[1]!.id, suite.cases[2]!.id] } });
    assert.equal((await fetch(route)).status, 404, 'The shared report loader preserves its selection contract.');
    assert.equal((await fetch(`${app.server.url}/api/rerun`)).status, 400);
    assert.equal((await fetch(`${app.server.url}/api/rerun?runId=..%2Fother`)).status, 400);
  } finally { await app.close(); }
});

test('comparison API reads report JSON without Markdown and enforces locale, compatibility, and origin checks', async () => {
  const app = await fixture();
  try {
    const suite = await readSuite(path.join(app.workspace, 'cases', 'task-flow.json'));
    const makeReport = async (runId: string, status: 'passed' | 'failed') => {
      const runDir = path.join(app.workspace, '.flowqa', 'runs', runId);
      await mkdir(runDir, { recursive: true });
      const result = failureReport({ suite, runId, suiteHash: 'a'.repeat(64),
        target: { name: 'demo', url: 'http://127.0.0.1:4178' },
        startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:01:00.000Z',
        blockedReasons: new Map() }, 'failed', 'Test failed');
      result.cases[0]!.status = status;
      result.cases[0]!.attempts.push({ index: 0, status, startedAt: '', durationMs: 1, secondaryErrors: [], steps: [],
        artifacts: [{ kind: 'log', redaction: 'complete', path: 'raw/artifacts/private.txt' }] });
      await writeFile(path.join(runDir, 'qa-report.json'), JSON.stringify(result));
      return { runDir, result };
    };
    const baseline = randomUUID();
    const current = randomUUID();
    const before = await makeReport(baseline, 'passed');
    const after = await makeReport(current, 'failed');
    const route = `/api/comparison?baseline=${baseline}&current=${current}`;
    const english = await fetch(`${app.server.url}${route}`);
    assert.equal(english.status, 200);
    assert.equal(english.headers.get('cache-control'), 'no-store');
    const payload = await english.json() as { comparison: { schemaVersion: string; counts: Record<string, number>; cases: { id: string; category: string }[] }; markdown: string };
    assert.equal(payload.comparison.schemaVersion, 'flow-qa/comparison-1');
    assert.equal(payload.comparison.counts['newly-failed'], 1);
    assert.equal(payload.comparison.cases[0]?.category, 'newly-failed');
    assert.match(payload.markdown, /QA run comparison/);
    assert.doesNotMatch(JSON.stringify(payload), /private\.txt|attempts|artifacts/);
    const korean = await fetch(`${app.server.url}${route}`, { headers: { 'accept-language': 'ko' } });
    assert.equal(korean.status, 200);
    const koPayload = await korean.json() as typeof payload;
    assert.deepEqual(koPayload.comparison, payload.comparison);
    assert.match(koPayload.markdown, /QA 실행 비교/);

    assert.equal((await fetch(`${app.server.url}/api/comparison?baseline=${baseline}`)).status, 400);
    assert.equal((await fetch(`${app.server.url}/api/comparison?baseline=..%2Fetc&current=${current}`)).status, 400);
    assert.equal((await fetch(`${app.server.url}/api/comparison?baseline=${baseline}&current=${baseline}`)).status, 400);
    const sameKo = await fetch(`${app.server.url}/api/comparison?baseline=${baseline}&current=${baseline}`, { headers: { 'accept-language': 'ko' } });
    assert.match((await sameKo.json() as { error: string }).error, /서로 다른 두 실행/);
    assert.equal((await fetch(`${app.server.url}/api/comparison?baseline=${baseline}&current=${randomUUID()}`)).status, 404);
    assert.equal((await fetch(`${app.server.url}${route}`, { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${app.server.url}${route}`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal(await statusWithHost(`${app.server.url}${route}`, 'evil.example'), 403);

    after.result.suiteId = 'different-suite';
    await writeFile(path.join(after.runDir, 'qa-report.json'), JSON.stringify(after.result));
    const incompatible = await fetch(`${app.server.url}${route}`, { headers: { 'accept-language': 'ko' } });
    assert.equal(incompatible.status, 409);
    assert.match((await incompatible.json() as { error: string }).error, /케이스 모음/);
    after.result.suiteId = before.result.suiteId;
    after.result.target = { name: 'other', url: 'https://other.example' };
    await writeFile(path.join(after.runDir, 'qa-report.json'), JSON.stringify(after.result));
    assert.equal((await fetch(`${app.server.url}${route}`)).status, 409);

    const outside = await mkdtemp(path.join(tmpdir(), 'flowqa-comparison-outside-'));
    try {
      const linkedRun = randomUUID();
      await symlink(outside, path.join(app.workspace, '.flowqa', 'runs', linkedRun));
      assert.equal((await fetch(`${app.server.url}/api/comparison?baseline=${baseline}&current=${linkedRun}`)).status, 404);
    } finally { await rm(outside, { recursive: true, force: true }); }
  } finally { await app.close(); }
});

test('artifact route serves only report-approved local evidence with safe response headers', async () => {
  const app = await fixture();
  try {
    const suite = await readSuite(path.join(app.workspace, 'cases', 'task-flow.json'));
    const runId = randomUUID();
    const runDir = path.join(app.workspace, '.flowqa', 'runs', runId);
    const artifactDir = path.join(runDir, 'raw', 'artifacts');
    await mkdir(artifactDir, { recursive: true });
    const report = failureReport({ suite, runId, suiteHash: 'hash', target: { name: 'demo', url: 'http://127.0.0.1:4178' },
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), blockedReasons: new Map() }, 'failed', 'Test failed');
    report.cases[0]!.attempts.push({ index: 0, status: 'failed', startedAt: new Date().toISOString(), durationMs: 1,
      secondaryErrors: [], steps: [], artifacts: [
        { kind: 'log', redaction: 'complete', path: 'raw/artifacts/trace.txt' },
        { kind: 'log', redaction: 'incomplete', path: 'raw/artifacts/hidden.txt' },
      ] });
    await writeFile(path.join(artifactDir, 'trace.txt'), 'bounded evidence');
    await writeFile(path.join(artifactDir, 'hidden.txt'), 'private evidence');
    await writeFile(path.join(runDir, 'qa-report.json'), JSON.stringify(report));
    await writeFile(path.join(runDir, 'qa-report.md'), renderMarkdown(report));
    const route = `/api/artifact?runId=${runId}&caseId=${suite.cases[0]!.id}&attempt=0&artifact=0`;
    const inline = await fetch(`${app.server.url}${route}`);
    assert.equal(inline.status, 200);
    assert.equal(inline.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(inline.headers.get('content-disposition') ?? '', /^inline; filename="TC-001-attempt-1-evidence-1\.txt"$/);
    assert.equal(inline.headers.get('cache-control'), 'no-store');
    assert.equal(await inline.text(), 'bounded evidence');
    const downloaded = await fetch(`${app.server.url}${route}&download=1`);
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.equal((await fetch(`${app.server.url}${route.replace('artifact=0', 'artifact=1')}`)).status, 404);
    assert.equal((await fetch(`${app.server.url}${route.replace('attempt=0', 'attempt=../0')}`)).status, 400);
    assert.equal((await fetch(`${app.server.url}/api/artifact?runId=${runId}&caseId=TC-001&attempt=0&artifact=9999`)).status, 400);
  } finally { await app.close(); }
});

test('close aborts a running operation', async () => {
  let aborted = false;
  const app = await fixture({ workspace: '', run: async ({ suite, config, targetName, signal }) => {
    await new Promise<void>((resolve) => signal?.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    const report = failureReport({ suite, runId: randomUUID(), suiteHash: 'hash', target: { name: targetName, url: 'url' in config.targets[targetName]! ? config.targets[targetName]!.url : '' },
      startedAt: '', finishedAt: '', blockedReasons: new Map() }, 'interrupted', 'Stopped');
    return { runDir: '', report };
  } });
  try {
    const suiteHash = await reviewedSuiteHash(app.server);
    const targetURL = (await state(app.server)).targets.find((target) => target.name === 'demo')!.url;
    assert.equal((await post(app.server, app.token, '/api/run', { suite: 'task-flow.json', suiteHash, targetName: 'demo', targetURL })).status, 202);
    await app.server.close();
    assert.equal(aborted, true);
  } finally { await app.close(); }
});
