import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { configSchema, suiteSchema, type Config, type Suite } from './schema.ts';

export const CONFIG_FILE = 'flowqa.config.json';
const localConfigWriters = new Map<string, Promise<void>>();

/** Serialize read-modify-write changes from CLI processes and the local UI. */
export async function withConfigLock<T>(workspace: string, change: () => Promise<T>, allowSymlink = true): Promise<T> {
  const alias = resolve(workspace, CONFIG_FILE);
  if (!allowSymlink && (await lstat(alias)).isSymbolicLink()) throw new Error('Invalid configuration file path.');
  let file: string;
  try { file = await realpath(alias); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('flowqa.config.json is missing. Run flow-qa init first.');
    throw error;
  }
  const lockDirectory = resolve(dirname(file), '.flowqa');
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(lockDirectory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || await realpath(lockDirectory) !== lockDirectory) {
    throw new Error('Invalid configuration lock path.');
  }
  const lockFile = resolve(lockDirectory, `config-lock-${sha256(file)}.sqlite`);
  const previous = localConfigWriters.get(lockFile);
  let releaseLocal!: () => void;
  const localTurn = new Promise<void>(resolveTurn => { releaseLocal = resolveTurn; });
  localConfigWriters.set(lockFile, localTurn);
  if (previous) await previous;
  try {
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    let handle;
    try { handle = await open(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      handle = await open(lockFile, constants.O_RDWR | noFollow);
    }
    try {
      const opened = await handle.stat();
      const pathInfo = await lstat(lockFile);
      if (!opened.isFile() || !pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1 ||
          opened.dev !== pathInfo.dev || opened.ino !== pathInfo.ino ||
          process.platform !== 'win32' && (opened.mode & 0o077) !== 0) {
        throw new Error('Invalid configuration lock file.');
      }
    } finally { await handle.close(); }
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(lockFile);
    const deadline = Date.now() + 20_000;
    let acquired = false;
    try {
      database.exec('PRAGMA busy_timeout = 0');
      while (!acquired) {
        try {
          database.exec('BEGIN IMMEDIATE');
          acquired = true;
        } catch (error) {
          if ((error as { errcode?: number }).errcode !== 5) throw error;
          if (Date.now() >= deadline) throw new Error('Could not update configuration while another process is saving it. Retry the command.');
          await delay(40);
        }
      }
      return await change();
    } finally {
      if (acquired) database.exec('ROLLBACK');
      database.close();
    }
  } finally {
    releaseLocal();
    if (localConfigWriters.get(lockFile) === localTurn) localConfigWriters.delete(lockFile);
  }
}
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
export async function writeConfig(workspace: string, config: Config): Promise<void> {
  const content = `${JSON.stringify(configSchema.parse(config), null, 2)}\n`;
  const alias = resolve(workspace, CONFIG_FILE);
  let file: string;
  try { file = await realpath(alias); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      if ((await lstat(alias)).isSymbolicLink()) throw new Error('Configuration symlink target does not exist.');
    } catch (inspectError) {
      if ((inspectError as NodeJS.ErrnoException).code !== 'ENOENT') throw inspectError;
    }
    file = alias;
  }
  await mkdir(dirname(file), { recursive: true });
  const temp = resolve(dirname(file), `.flowqa-config-${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await open(temp, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temp, file);
  } catch (error) {
    if (created) {
      try { await unlink(temp); }
      catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw new AggregateError([error, cleanupError], 'Could not save configuration or clean up its temporary file.');
      }
    }
    throw error;
  }
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
