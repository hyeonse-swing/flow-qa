import { suiteSchema, type Case, type Locator, type Step, type Suite } from './schema.ts';

const literal = (value: string | boolean): string => JSON.stringify(value);

function locatorCode(locator: Locator): string {
  if (locator.by === 'role') {
    return locator.name === undefined
      ? `screen.getByRole(${literal(locator.value)})`
      : `screen.getByRole(${literal(locator.value)}, ${literal(locator.name)})`;
  }
  const method = { text: 'getByText', label: 'getByLabel', testId: 'getByTestId' }[locator.by];
  return `screen.${method}(${literal(locator.value)})`;
}

function stepCode(step: Step): string {
  switch (step.type) {
    case 'open': return `await app.open(${literal(step.path)});`;
    case 'act': return `await agent.act(${literal(step.instruction)});`;
    case 'click': return `await ${locatorCode(step.locator)}.tap();`;
    case 'fill': return `await ${locatorCode(step.locator)}.fill(${literal(step.value)});`;
    case 'assertVisible': return `await expect(${locatorCode(step.locator)})${step.visible ? '' : '.not'}.toBeVisible();`;
    case 'assertText': return `await expect(${locatorCode(step.locator)}).${step.match === 'contains' ? 'toContainText' : 'toHaveText'}(${literal(step.expected)});`;
    case 'assertUrl': return `await expect(browser).toHaveURL(${literal(step.expected)});`;
    case 'assertAgent': return `await agent.assert(${literal(step.instruction)});`;
  }
}

export function expectedChecks(testCase: Case): string[] {
  return testCase.steps.flatMap((step) => {
    switch (step.type) {
      case 'assertVisible': return [`${step.visible ? 'Visible' : 'Hidden'}: ${JSON.stringify(step.locator)}`];
      case 'assertText': return [`Text ${step.match}: ${JSON.stringify(step.locator)} → ${step.expected}`];
      case 'assertUrl': return [`URL: ${step.expected}`];
      case 'assertAgent': return [`Agent assertion: ${step.instruction}`];
      default: return [];
    }
  });
}

export function needsAgent(suite: Suite): boolean {
  return suite.cases.some((testCase) => !testCase.questions.length && testCase.steps.some((step) => step.type === 'act' || step.type === 'assertAgent'));
}

export function compileSuite(suite: Suite): string {
  const parsed = suiteSchema.parse(suite);
  const lines = ["import { test } from '@e2e-dev/web';", "import { expect } from 'e2e';", ''];
  for (const testCase of parsed.cases) {
    const title = literal(`[${testCase.id}] ${testCase.title}`);
    if (testCase.questions.length) {
      lines.push(`test.skip(${title}, async () => {});`);
      continue;
    }
    const fixtures = ['app'];
    if (testCase.steps.some((step) => 'locator' in step)) fixtures.push('screen');
    if (testCase.steps.some((step) => step.type === 'assertUrl')) fixtures.push('browser');
    if (testCase.steps.some((step) => step.type === 'act' || step.type === 'assertAgent')) fixtures.push('agent');
    lines.push(`test(${title}, async ({ ${fixtures.join(', ')} }) => {`);
    if (testCase.steps[0]?.type !== 'open') lines.push("  await app.open('/');");
    for (const step of testCase.steps) lines.push(`  ${stepCode(step)}`);
    lines.push('});');
  }
  return `${lines.join('\n')}\n`;
}
