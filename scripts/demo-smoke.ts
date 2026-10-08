import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { startDemo } from '../examples/demo/server.ts';
import { demoSuite } from '../src/workspace.ts';
import { configSchema } from '../src/schema.ts';
import { runSuite } from '../src/engine.ts';

const workspace = resolve('.');
const demo = await startDemo(0);
const config = configSchema.parse({ schemaVersion: 'flow-qa/config-1', targets: { demo: { url: demo.url } }, timeoutMs: 15000, retries: 0 });
const runs: { kind: string; status: string; runDir: string }[] = [];
try {
  const passed = await runSuite({ workspace, suite: demoSuite, config, targetName: 'demo' });
  runs.push({ kind: 'Normal browser flow', status: passed.report.status, runDir: passed.runDir });
  assert.equal(passed.report.status, 'passed', JSON.stringify(passed.report.errors));
  assert.equal(passed.report.cases.filter((c) => c.status === 'passed').length, 3);

  const failing = structuredClone(demoSuite);
  failing.id = 'intentional-failure';
  failing.title = 'Intentional assertion failure for report classification';
  failing.cases = [failing.cases[1]!];
  failing.requirements = failing.requirements.filter((r) => failing.cases[0]!.requirementIds.includes(r.id));
  failing.cases[0]!.steps[failing.cases[0]!.steps.length - 1] = { type: 'assertText', locator: { by: 'role', value: 'alert' }, expected: 'An intentionally incorrect expectation', match: 'equals' };
  const failed = await runSuite({ workspace, suite: failing, config, targetName: 'demo' });
  runs.push({ kind: 'Intentional assertion failure', status: failed.report.status, runDir: failed.runDir });
  assert.equal(failed.report.status, 'failed');
  assert.equal(failed.report.cases[0]?.status, 'failed');
  assert.notEqual(passed.runDir, failed.runDir);
} finally { await demo.close(); }

const unavailable = await runSuite({ workspace, suite: { ...demoSuite, requirements: [demoSuite.requirements[0]!], cases: [demoSuite.cases[0]!] }, config, targetName: 'demo' });
runs.push({ kind: 'Stopped app', status: unavailable.report.status, runDir: unavailable.runDir });
assert.notEqual(unavailable.report.status, 'passed');
assert.ok(['error', 'blocked'].includes(unavailable.report.status), 'Unavailable apps must be classified separately from assertion failures.');
assert.equal(unavailable.report.cases.some((c) => c.status === 'passed'), false);
const summary = `# Flow QA local verification\n\nLocal demo verification using real Chromium and the installed e2e engine. No model calls, external service logins, or real business data were used.\n\n${runs.map((r) => `- ${r.kind}: **${r.status}** — [QA report](<${r.runDir}/qa-report.md>)`).join('\n')}\n`;
await writeFile(resolve(workspace, '.flowqa/verification.md'), summary);
console.log(summary);
