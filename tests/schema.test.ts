import test from 'node:test';
import assert from 'node:assert/strict';
import { suiteSchema, configSchema, stepSchema, modelSchema, plannerSchema, targetSchema, type Suite } from '../src/schema.ts';
import { demoSuite } from '../src/workspace.ts';

test('runnable cases require an assertion and a known requirement', () => {
  const suite = structuredClone(demoSuite);
  suite.cases[0]!.steps = [{ type: 'open', path: '/' }];
  assert.equal(suiteSchema.safeParse(suite).success, false);
  suite.cases[0]!.questions = ['Expected result is not defined yet'];
  assert.equal(suiteSchema.safeParse(suite).success, true);
  suite.cases[0]!.requirementIds = ['UNKNOWN'];
  assert.equal(suiteSchema.safeParse(suite).success, false);
});

test('planner and agent accept only generic OpenAI-compatible model metadata', () => {
  const model = { baseURL: 'https://model.example/v1', model: 'test-model', apiKeyEnv: 'FLOW_QA_TEST_KEY' };
  assert.equal(plannerSchema, modelSchema);
  const config = { schemaVersion: 'flow-qa/config-1', targets: {}, planner: model, agent: model };
  assert.equal(configSchema.safeParse(config).success, true);
  assert.equal(configSchema.safeParse({ ...config, planner: { ...model, provider: 'unsupported-provider' } }).success, false);
  assert.equal(configSchema.safeParse({ ...config, planner: { ...model, usageContext: { team: 'dev-fe' } } }).success, false);
  assert.equal(configSchema.safeParse({ ...config, planner: { ...model, apiKey: 'never-store-a-token' } }).success, false);
  assert.equal(configSchema.safeParse({ ...config, agent: { ...model, provider: 'unsupported-provider' } }).success, false);
});

test('reject duplicate IDs, raw scripts, external navigation, and credential URLs', () => {
  const suite = structuredClone(demoSuite);
  suite.cases.push(suite.cases[0]!);
  assert.equal(suiteSchema.safeParse(suite).success, false);
  assert.equal(stepSchema.safeParse({ type: 'eval', code: 'process.exit()' }).success, false);
  for (const path of ['https://example.com', '//example.com', '/\\example.com']) {
    assert.equal(stepSchema.safeParse({ type: 'open', path }).success, false);
  }
  assert.equal(configSchema.safeParse({ schemaVersion: 'flow-qa/config-1', targets: { app: { url: 'https://user:password@example.com' } } }).success, false);
  for (const url of ['http://remote.example.test', 'https://example.test?token=value', 'https://example.test#route']) {
    assert.equal(configSchema.safeParse({ schemaVersion: 'flow-qa/config-1', targets: { app: { url } } }).success, false);
  }
});

test('legacy web targets and suites keep their serialized shape', () => {
  const web = targetSchema.parse({ url: 'https://example.test' });
  assert.deepEqual(web, { url: 'https://example.test', description: '' });
  assert.equal('kind' in web, false);
  assert.equal('platform' in suiteSchema.parse(demoSuite), false);
  assert.deepEqual(targetSchema.parse({ kind: 'web', url: 'https://example.test' }), { url: 'https://example.test', description: '', kind: 'web' });
});

test('native targets require a safe app ID and an explicit device', () => {
  const native = { kind: 'mobile', platform: 'ios', bundleId: 'com.example.app', device: ' iPhone 17 Pro ' };
  assert.deepEqual(targetSchema.parse(native), { ...native, device: 'iPhone 17 Pro', description: '' });
  for (const invalid of [
    { ...native, device: '' }, { ...native, device: '\n' }, { ...native, device: `Pixel\u0000` },
    { ...native, bundleId: 'com.example;id' }, { ...native, bundleId: 'com.example/app' },
    { ...native, bundleId: 'com.example\napp' }, { ...native, platform: 'windows' },
    { ...native, url: 'https://example.test' },
  ]) assert.equal(targetSchema.safeParse(invalid).success, false);
});

test('suite steps are restricted to their platform even in question-blocked cases', () => {
  const web = structuredClone(demoSuite);
  for (const step of [{ type: 'launchApp' }, { type: 'back' }, { type: 'swipe', direction: 'up' }]) {
    web.cases[0]!.steps.push(step as never);
    assert.equal(suiteSchema.safeParse(web).success, false);
    web.cases[0]!.steps.pop();
  }
  const mobile: Suite = { ...web, platform: 'mobile', requirements: [web.requirements[0]!],
    cases: [{ ...web.cases[0]!, requirementIds: [web.requirements[0]!.id], questions: ['later'], steps: [{ type: 'open', path: '/' }] }] };
  assert.equal(suiteSchema.safeParse(mobile).success, false);
  mobile.cases[0]!.steps = [{ type: 'assertUrl', expected: '/' }];
  assert.equal(suiteSchema.safeParse(mobile).success, false);
  mobile.cases[0]!.steps = [{ type: 'launchApp' }, { type: 'swipe', direction: 'left' }, { type: 'back' }, { type: 'assertAgent', instruction: 'Ready' }];
  assert.equal(suiteSchema.safeParse(mobile).success, true);
  assert.equal(stepSchema.safeParse({ type: 'swipe', direction: 'diagonal' }).success, false);
  assert.equal(stepSchema.safeParse({ type: 'back', path: '/' }).success, false);
});
