import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { buildPlanningPrompt, planFlow, PlannerError } from '../src/planner.ts';
import { type PlannerConnection, type Suite } from '../src/schema.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; delete process.env.FLOW_QA_TEST_KEY; });

const suite: Suite = {
  schemaVersion: 'flow-qa/suite-1', id: 'suite-1', title: 'A flow',
  requirements: [{ id: 'REQ-1', text: 'The page shows Ready.' }],
  cases: [{ id: 'CASE-1', title: 'Page loads', requirementIds: ['REQ-1'], preconditions: [], questions: [], steps: [
    { type: 'open', path: '/' }, { type: 'assertVisible', locator: { by: 'text', value: 'Ready' }, visible: true },
  ] }],
};

test('prompt carries schema, example, ground truth, and blocked-question policy', () => {
  const prompt = buildPlanningPrompt('### Given\nA user opens the app');
  assert.match(prompt, /flow-qa\/suite-1/);
  assert.match(prompt, /schemaVersion/);
  assert.match(prompt, /CASE-1/);
  assert.match(prompt, /sole ground truth/);
  assert.match(prompt, /observation alone does not establish the expected outcome/);
  assert.match(prompt, /precondition.*question/);
  assert.match(prompt, /arbitrary JavaScript/);
  assert.match(prompt, /Omit source unless the exact file path and hash were supplied/);
  assert.match(prompt, /never put model endpoints, API keys/);
  assert.match(prompt, /### Given\nA user opens the app/);
});

test('planner sends separate roles to the explicit endpoint and validates a suite', async () => {
  process.env.FLOW_QA_TEST_KEY = 'sensitive-secret';
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://model.example/v1/chat/completions');
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer sensitive-secret');
    assert.equal(init?.redirect, 'error');
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request.messages.map((item: { role: string }) => item.role), ['system', 'user']);
    assert.match(request.messages[1].content, /A user opens the app/);
    assert.ok(init?.signal);
    return Response.json({ choices: [{ message: { content: JSON.stringify(suite) } }] });
  };
  assert.deepEqual(await planFlow('A user opens the app', { baseURL: 'https://model.example/v1', model: 'test', apiKeyEnv: 'FLOW_QA_TEST_KEY' }), suite);
});

test('planner rejects a redirected provider request without exposing a credential', async () => {
  process.env.FLOW_QA_TEST_KEY = 'sensitive-secret';
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.redirect, 'error');
    throw new TypeError('redirect to https://other.example with sensitive-secret denied');
  };
  await assert.rejects(
    planFlow('private flow', { baseURL: 'https://model.example/v1', model: 'test', apiKeyEnv: 'FLOW_QA_TEST_KEY' }),
    (error: Error) => {
      assert.equal(error.message, 'Planner request failed.');
      return true;
    },
  );
});

test('planner rejects invalid suites and hides provider payload and key in errors', async () => {
  process.env.FLOW_QA_TEST_KEY = 'sensitive-secret';
  const model = { baseURL: 'https://model.example/v1', model: 'test', apiKeyEnv: 'FLOW_QA_TEST_KEY' };
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({ ...suite, schemaVersion: 'wrong' }) } }] });
  await assert.rejects(planFlow('flow', model), /invalid suite/);
  globalThis.fetch = async () => new Response('secret-provider-payload', { status: 429 });
  await assert.rejects(planFlow('flow', model), (error: Error) => {
    assert.match(error.message, /HTTP 429/);
    assert.doesNotMatch(error.message, /secret-provider-payload|sensitive-secret/);
    return true;
  });
  globalThis.fetch = async () => { throw new Error('sensitive-secret transport failure'); };
  await assert.rejects(planFlow('flow', model), (error: Error) => {
    assert.doesNotMatch(error.message, /sensitive-secret/);
    return true;
  });
});

test('planner requires the declared credential without contacting a provider', async () => {
  globalThis.fetch = async () => { throw new Error('must not fetch'); };
  await assert.rejects(planFlow('flow', { baseURL: 'https://model.example', model: 'test', apiKeyEnv: 'FLOW_QA_TEST_KEY' }), /environment variable is missing/);
});

test('invalid model output exposes actionable schema locations without response values', async () => {
  const invalid = structuredClone(suite);
  invalid.cases[0]!.steps = [{ type: 'fill', locator: { by: 'text', value: 'sensitive-secret' }, value: 'private-input' }];
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify(invalid) } }] });
  await assert.rejects(planFlow('flow', { baseURL: 'https://model.example', model: 'test' }), (error: unknown) => {
    assert.ok(error instanceof PlannerError);
    assert.equal(error.code, 'invalid-suite');
    assert.equal(error.issues?.[0]?.path, 'cases.0.steps');
    assert.match(error.issues?.[0]?.message ?? '', /expected-result/);
    assert.doesNotMatch(JSON.stringify(error), /sensitive-secret|private-input/);
    return true;
  });
});

test('planner rejects former provider metadata before making a request', async () => {
  globalThis.fetch = async () => { throw new Error('must not fetch'); };
  const formerProvider = { provider: 'unsupported-provider', baseURL: 'https://workspace.example', model: 'planner',
    usageContext: { team: 'dev-fe', service: 'test-fixture', env: 'dev', feature: 'planning' } } as unknown as PlannerConnection;
  await assert.rejects(planFlow('flow', formerProvider));
});

test('mobile planning works before any app or device is configured', async () => {
  const mobile: Suite = { ...suite, platform: 'mobile', cases: [{ ...suite.cases[0]!, steps: [
    { type: 'launchApp' }, { type: 'assertVisible', locator: { by: 'text', value: 'Ready' }, visible: true },
  ] }] };
  const prompt = buildPlanningPrompt('The app shows Ready after launch.', 'mobile');
  assert.match(prompt, /platform: "mobile"/);
  assert.match(prompt, /"type": "launchApp"/);
  assert.match(prompt, /Never use web open paths or assertUrl/);
  assert.match(prompt, /runtime target is configured separately after planning/);
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    assert.match(request.messages[1].content, /platform: "mobile"/);
    return Response.json({ choices: [{ message: { content: JSON.stringify(mobile) } }] });
  };
  assert.deepEqual(await planFlow('The app shows Ready after launch.', { baseURL: 'https://model.example/v1', model: 'test' }, { platform: 'mobile' }), mobile);
});

test('planner rejects a response for a different platform instead of relabelling it', async () => {
  const model = { baseURL: 'https://model.example/v1', model: 'test' };
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify(suite) } }] });
  await assert.rejects(planFlow('Native app', model, { platform: 'mobile' }), (error: unknown) => {
    assert.ok(error instanceof PlannerError);
    assert.equal(error.code, 'invalid-suite');
    assert.equal(error.issues?.[0]?.path, 'platform');
    return true;
  });
  const mobile: Suite = { ...suite, platform: 'mobile', cases: [{ ...suite.cases[0]!, steps: [
    { type: 'assertVisible', locator: { by: 'text', value: 'Ready' }, visible: true },
  ] }] };
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify(mobile) } }] });
  await assert.rejects(planFlow('Web page', model), /invalid suite/);
});
