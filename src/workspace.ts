import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { configSchema, suiteSchema, type Config, type Suite } from './schema.ts';

export const CONFIG_FILE = 'flowqa.config.json';
export async function readConfig(workspace: string): Promise<Config> {
  try { return configSchema.parse(JSON.parse(await readFile(resolve(workspace, CONFIG_FILE), 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('flowqa.config.json is missing. Run flow-qa init first.');
    throw error;
  }
}
export async function readSuite(path: string): Promise<Suite> {
  return suiteSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
export async function writeJSON(path: string, data: unknown, exclusive = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { flag: exclusive ? 'wx' : 'w', mode: 0o600 });
}
export function sha256(text: string): string { return createHash('sha256').update(text).digest('hex'); }

export async function verifySuiteSource(suite: Suite, workspace: string): Promise<void> {
  if (!suite.source) return;
  let source: string;
  try { source = await readFile(resolve(workspace, suite.source.file), 'utf8'); }
  catch { throw new Error('Cannot read the source flow for these cases. Restore the file or regenerate the cases from the specification.'); }
  if (sha256(source) !== suite.source.sha256) throw new Error('STALE_SUITE: The flow changed. Regenerate the cases from the current specification.');
}

export const demoFlow = `# Create and filter tasks\n\nThe target is the local demo app included with Flow QA. Each test starts with an empty list.\n\n## Confirmed requirements\n- Entering a title and adding it displays the title in the list.\n- Adding an empty title shows the error 'Enter a task title.'\n- A completed task disappears from the 'Active' filter and remains visible under 'All'.\n\n## UI contract\n- Title input: label 'Task title'\n- Add button: role button, name 'Add'\n- List: testId 'task-list'\n- Empty title error: role alert\n- Complete button: role button, name 'Complete'\n- Filters: role button, name 'Active' or 'All'\n\n## Execution scope\nOnly temporary items in the local demo are used. No external account, real payment, or persistent storage is involved.\n`;

export const demoSuite: Suite = suiteSchema.parse({
  schemaVersion: 'flow-qa/suite-1', id: 'task-flow', title: 'Create and filter tasks',
  requirements: [
    { id: 'R1', text: 'A task is added with the entered title.' },
    { id: 'R2', text: 'Adding an empty title shows an error.' },
    { id: 'R3', text: 'Completed tasks are hidden from Active and remain under All.' },
  ],
  cases: [
    { id: 'TC-001', title: 'Create a task with a title', requirementIds: ['R1'], preconditions: ['Empty list on a new page'], questions: [], steps: [
      { type: 'open', path: '/' }, { type: 'fill', locator: { by: 'label', value: 'Task title' }, value: 'First QA run' },
      { type: 'click', locator: { by: 'role', value: 'button', name: 'Add' } },
      { type: 'assertText', locator: { by: 'testId', value: 'task-list' }, expected: 'First QA run', match: 'contains' },
    ] },
    { id: 'TC-002', title: 'Show an error for an empty title', requirementIds: ['R2'], preconditions: ['Empty list on a new page'], questions: [], steps: [
      { type: 'open', path: '/' }, { type: 'click', locator: { by: 'role', value: 'button', name: 'Add' } },
      { type: 'assertText', locator: { by: 'role', value: 'alert' }, expected: 'Enter a task title.', match: 'equals' },
    ] },
    { id: 'TC-003', title: 'Hide completed tasks from Active', requirementIds: ['R3'], preconditions: ['Empty list on a new page'], questions: [], steps: [
      { type: 'open', path: '/' }, { type: 'fill', locator: { by: 'label', value: 'Task title' }, value: 'Task to complete' },
      { type: 'click', locator: { by: 'role', value: 'button', name: 'Add' } },
      { type: 'click', locator: { by: 'role', value: 'button', name: 'Complete' } },
      { type: 'click', locator: { by: 'role', value: 'button', name: 'Active' } },
      { type: 'assertVisible', locator: { by: 'text', value: 'Task to complete' }, visible: false },
      { type: 'click', locator: { by: 'role', value: 'button', name: 'All' } },
      { type: 'assertVisible', locator: { by: 'text', value: 'Task to complete' }, visible: true },
    ] },
  ],
});

export async function initWorkspace(workspace: string): Promise<string[]> {
  const written: string[] = [];
  const files: Record<string, string> = {
    [CONFIG_FILE]: `${JSON.stringify(configSchema.parse({ schemaVersion: 'flow-qa/config-1', targets: { demo: { url: 'http://127.0.0.1:4178', description: 'Local task demo' } } }), null, 2)}\n`,
    'flows/task-flow.md': demoFlow,
    'cases/task-flow.json': `${JSON.stringify({ ...demoSuite, source: { file: 'flows/task-flow.md', sha256: sha256(demoFlow) } }, null, 2)}\n`,
    '.gitignore': '.flowqa/\n.env\n.env.*\n',
    '.flowqa/.gitignore': '*\n',
  };
  for (const [file, content] of Object.entries(files)) {
    const path = resolve(workspace, file);
    await mkdir(dirname(path), { recursive: true });
    try { await writeFile(path, content, { flag: 'wx', mode: 0o600 }); written.push(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  return written;
}
