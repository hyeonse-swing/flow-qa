import test from 'node:test';
import assert from 'node:assert/strict';
import { suiteSchema, configSchema, stepSchema, modelSchema, plannerSchema } from '../src/schema.ts';
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
