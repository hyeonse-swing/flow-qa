import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runSuite } from '../src/engine.ts';
import { compareReports, renderComparisonMarkdown } from '../src/run-comparison.ts';

let responseText = 'Ready';
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><p data-testid="status">${request.url === '/after' ? responseText : 'Ready'}</p>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const targetUrl = `http://127.0.0.1:${server.address().port}`;
const suite = {
  schemaVersion: 'flow-qa/suite-1', id: 'step-difference', title: 'Repeated assertions',
  requirements: [{ id: 'REQ1', text: 'The status stays ready' }],
  cases: [{ id: 'CASE1', title: 'Repeated assertion around an action', requirementIds: ['REQ1'],
    preconditions: [], questions: [], steps: [
      { type: 'assertText', locator: { by: 'testId', value: 'status' }, expected: 'Ready', match: 'equals' },
      { type: 'open', path: '/after' },
      { type: 'assertText', locator: { by: 'testId', value: 'status' }, expected: 'Ready', match: 'equals' },
      { type: 'assertVisible', locator: { by: 'testId', value: 'status' }, visible: true },
    ] }],
};
const config = {
  schemaVersion: 'flow-qa/config-1',
  targets: { local: { url: targetUrl, description: '' } },
  timeoutMs: 5_000, retries: 1,
};
const workspace = await mkdtemp(path.join(tmpdir(), 'flowqa-step-comparison-'));
const out = path.resolve('output/step-comparison-smoke');
await mkdir(out, { recursive: true });

try {
  const baseline = await runSuite({ workspace, suite, config, targetName: 'local' });
  responseText = 'Broken';
  const current = await runSuite({ workspace, suite, config, targetName: 'local' });
  const comparison = compareReports(baseline.report, current.report);
  const details = comparison.cases[0]?.stepComparison;
  assert.equal(baseline.report.suiteHash, current.report.suiteHash);
  assert.equal(baseline.report.cases[0]?.status, 'passed');
  assert.equal(current.report.cases[0]?.status, 'failed');
  assert.equal(details?.availability, 'compared');
  assert.deepEqual(details?.baselineAttempt, { index: 1, total: 1, status: 'passed' });
  assert.deepEqual(details?.currentAttempt, { index: 2, total: 2, status: 'failed' });
  assert.equal(details?.baselineSetupSteps, 1);
  assert.equal(details?.currentSetupSteps, 1);
  assert.equal(details?.lastCommonPassedStepIndex, 1);
  assert.equal(details?.firstDifferenceStepIndex, 2);
  assert.deepEqual(details?.steps?.map((step) => [step.index, step.baseline, step.current]), [
    [0, 'passed', 'passed'], [1, 'passed', 'passed'], [2, 'passed', 'failed'], [3, 'passed', 'not-run'],
  ]);
  const rawBaseline = JSON.parse(await readFile(path.join(baseline.runDir, 'raw/report.json'), 'utf8'));
  const rawCurrent = JSON.parse(await readFile(path.join(current.runDir, 'raw/report.json'), 'utf8'));
  const rawSteps = rawCurrent.run.results[0].attempts.at(-1).steps;
  assert.equal(rawSteps[0].source.file, 'suite.e2e.ts');
  assert.equal(rawSteps[0].source.line, 5);
  assert.equal(rawSteps[3].source.line, 8);
  assert.equal(baseline.report.cases[0].attempts[0].steps[3].sourceStepIndex, 2);
  assert.equal(current.report.cases[0].attempts[1].steps[3].sourceStepIndex, 2);
  for (const [name, run, raw] of [['baseline', baseline, rawBaseline], ['current', current, rawCurrent]]) {
    await writeFile(path.join(out, `${name}-raw.json`), JSON.stringify(raw, null, 2) + '\n');
    await writeFile(path.join(out, `${name}-report.json`), JSON.stringify(run.report, null, 2) + '\n');
    await writeFile(path.join(out, `${name}-step-map.json`), await readFile(path.join(run.runDir, 'step-map.json')));
  }
  await writeFile(path.join(out, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n');
  await writeFile(path.join(out, 'comparison.md'), renderComparisonMarkdown(comparison, 'ko') + '\n');
  console.log(JSON.stringify({ status: 'passed', e2eVersion: '0.22.0', target: targetUrl,
    suiteHash: baseline.report.suiteHash,
    attempts: [details.baselineAttempt, details.currentAttempt],
    lastCommonPassedStep: details.lastCommonPassedStepIndex + 1,
    firstDifferenceStep: details.firstDifferenceStepIndex + 1, evidence: out }));
} finally {
  server.close();
}
