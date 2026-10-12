import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import ts from 'typescript';
import { compileSuite, expectedChecks, needsAgent } from '../src/compiler.ts';
import type { Suite } from '../src/schema.ts';

const hostile = 'x" ); process.exit(1); //\n` ${danger}';
const suite: Suite = {
  schemaVersion: 'flow-qa/suite-1', id: 'safe-suite', title: 'Safe suite',
  requirements: [{ id: 'REQ-1', text: 'A result appears.' }],
  cases: [
    { id: 'CASE-1', title: hostile, requirementIds: ['REQ-1'], preconditions: [], questions: [], steps: [
      { type: 'fill', locator: { by: 'label', value: hostile }, value: hostile },
      { type: 'click', locator: { by: 'role', value: 'button', name: hostile } },
      { type: 'assertText', locator: { by: 'testId', value: 'result' }, expected: hostile, match: 'contains' },
      { type: 'assertVisible', locator: { by: 'text', value: 'Missing' }, visible: false },
      { type: 'assertUrl', expected: '/done' },
    ] },
    { id: 'CASE-2', title: 'Needs a known account', requirementIds: ['REQ-1'], preconditions: [], questions: ['Which account?'], steps: [
      { type: 'act', instruction: 'Log in somehow' },
    ] },
  ],
};

test('compiler emits fixed API calls with encoded literals and skips questions', () => {
  const output = compileSuite(suite);
  assert.match(output, /import \{ test \} from '@e2e-dev\/web';/);
  assert.match(output, /import \{ expect \} from 'e2e';/);
  assert.ok(output.includes(`test(${JSON.stringify(`[CASE-1] ${hostile}`)}, async ({ app, screen, browser }) => {`));
  assert.match(output, /await app\.open\('\/'\);/);
  assert.ok(output.includes(`screen.getByLabel(${JSON.stringify(hostile)}).fill(${JSON.stringify(hostile)})`));
  assert.ok(output.includes(`screen.getByRole("button", ${JSON.stringify(hostile)}).tap()`));
  assert.ok(output.includes(`toContainText(${JSON.stringify(hostile)})`));
  assert.match(output, /\.not\.toBeVisible\(\)/);
  assert.match(output, /expect\(browser\)\.toHaveURL\("\/done"\)/);
  assert.match(output, /test\.skip\("\[CASE-2\] Needs a known account", async \(\) => \{\}\);/);
  assert.doesNotMatch(output, /agent\.act\("Log in somehow"\)/);
  const generated = ts.transpileModule(output, { fileName: 'generated.test.ts', reportDiagnostics: true });
  assert.deepEqual(generated.diagnostics, []);
});

test('compiler honors an explicit first open and detects only runnable agent steps', () => {
  const withOpen: Suite = { ...suite, cases: [{ ...suite.cases[0]!, steps: [
    { type: 'open', path: '/start' }, { type: 'assertAgent', instruction: 'The chart is clear' },
  ] }] };
  const output = compileSuite(withOpen);
  assert.equal(output.match(/app\.open/g)?.length, 1);
  assert.match(output, /app\.open\("\/start"\)/);
  assert.match(output, /agent\.assert\("The chart is clear"\)/);
  assert.equal(needsAgent(withOpen), true);
  assert.equal(needsAgent(suite), false);
  assert.equal(expectedChecks(withOpen.cases[0]!).length, 1);
  assert.deepEqual(expectedChecks(suite.cases[0]!).map((value) => value.split(':')[0]), ['Text contains', 'Hidden', 'URL']);
});

test('descriptive preconditions run when steps establish them; questions block', () => {
  const conditional: Suite = { ...suite, cases: [{ ...suite.cases[0]!, preconditions: ['The new page has an empty list'], steps: [
    { type: 'assertVisible', locator: { by: 'text', value: 'No items' }, visible: true },
    { type: 'act', instruction: 'Add an item' }, { type: 'assertAgent', instruction: 'The item appears' },
  ] }] };
  assert.match(compileSuite(conditional), /test\("\[CASE-1\]/);
  assert.equal(needsAgent(conditional), true);
  const blocked: Suite = { ...conditional, cases: [{ ...conditional.cases[0]!, questions: ['How is an item added?'] }] };
  assert.match(compileSuite(blocked), /test\.skip\("\[CASE-1\]/);
  assert.equal(needsAgent(blocked), false);
});

test('compiler rejects malformed suite data before code generation', () => {
  assert.throws(() => compileSuite({ ...suite, schemaVersion: 'invalid' } as unknown as Suite));
});

test('native compiler emits escaped mobile actions without a browser fixture and typechecks against the SDK', () => {
  const native: Suite = { ...suite, platform: 'mobile', cases: [{ ...suite.cases[0]!, steps: [
    { type: 'launchApp' }, { type: 'swipe', direction: 'up' }, { type: 'back' },
    { type: 'fill', locator: { by: 'label', value: hostile }, value: hostile },
    { type: 'click', locator: { by: 'role', value: 'button', name: hostile } },
    { type: 'assertVisible', locator: { by: 'text', value: hostile }, visible: false },
    { type: 'assertText', locator: { by: 'testId', value: hostile }, expected: hostile, match: 'contains' },
    { type: 'act', instruction: hostile }, { type: 'assertAgent', instruction: hostile },
  ] }] };
  const output = compileSuite(native);
  assert.match(output, /import \{ test \} from '@e2e-dev\/mobile';/);
  assert.doesNotMatch(output, /@e2e-dev\/web|\bbrowser\b|toHaveURL/);
  assert.ok(output.includes(`test(${JSON.stringify(`[CASE-1] ${hostile}`)}, async ({ app, screen, agent }) => {`));
  assert.equal(output.match(/await app\.open\(\)/g)?.length, 1);
  assert.match(output, /await app\.back\(\)/);
  assert.match(output, /await screen\.swipe\(\{ direction: "up" \}\)/);
  assert.ok(output.includes(`screen.getByLabel(${JSON.stringify(hostile)}).fill(${JSON.stringify(hostile)})`));
  assert.ok(output.includes(`agent.act(${JSON.stringify(hostile)})`));
  const fileName = path.resolve('tests/.generated-mobile-suite.ts');
  const options: ts.CompilerOptions = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2023, strict: true, skipLibCheck: true, noEmit: true, types: ['node'] };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => name === fileName
    ? ts.createSourceFile(name, output, languageVersion, true)
    : original(name, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([fileName], options, host);
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});

test('native compiler launches the pinned app when the first step is not launchApp', () => {
  const native: Suite = { ...suite, platform: 'mobile', cases: [{ ...suite.cases[0]!, steps: [
    { type: 'swipe', direction: 'left' }, { type: 'assertAgent', instruction: 'Page changed' },
  ] }] };
  const output = compileSuite(native);
  assert.match(output, /async \(\{ app, screen, agent \}\) => \{\n  await app\.open\(\);\n  await screen\.swipe/);
  assert.equal(output.match(/await app\.open\(\)/g)?.length, 1);
});
