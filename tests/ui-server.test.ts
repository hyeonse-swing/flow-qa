import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPreferenceScript } from '@hyeonse/design-system/preferences';
import { PlannerError } from '../src/planner.ts';
import { failureReport, renderMarkdown } from '../src/report.ts';
import { targetFingerprint } from '../src/targets.ts';
import type { Config, Suite } from '../src/schema.ts';
import { startUIServer, type UIServerHandle } from '../src/ui/server.ts';
import { initWorkspace, readConfig, readSuite } from '../src/workspace.ts';

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
