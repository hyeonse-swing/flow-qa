import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const npmCLI = process.env.npm_execpath;
assert.ok(npmCLI, 'Run via npm run check:package.');
const result = spawnSync(process.execPath, [npmCLI, 'pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
const [pack] = JSON.parse(result.stdout);
const files = pack.files.map((file) => file.path);
assert.deepEqual(pack.bundled, [], 'No dependency packages may be bundled.');
for (const file of files) {
  assert.ok(file.startsWith('dist/') || file.startsWith('licenses/') || /^docs\/[^/]+\.md$/.test(file) || /^skills\/flow-qa\/(SKILL\.md|references\/workflow\.md)$/.test(file) || ['package.json', 'README.md', 'README.ko.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'llms.txt'].includes(file), `Unexpected package file: ${file}`);
  assert.ok(!/(^|\/)(\.env(?:\.|$)|\.npmrc|\.flowqa|\.git)(\/|$)/.test(file), `Private file in package: ${file}`);
  if (file.startsWith('dist/')) assert.ok(!file.endsWith('.ts'), `Uncompiled TypeScript: ${file}`);
}
for (const required of ['dist/bin/flow-qa.mjs', 'dist/src/cli.js', 'dist/src/ui/entry.js', 'dist/src/ui/public/index.html', 'dist/src/ui/public/app.js', 'dist/src/ui/public/i18n.js', 'dist/src/ui/design-system/tokens.css', 'dist/src/ui/design-system/components.css', 'dist/src/ui/design-system/preferences.js', 'dist/src/ui/design-system/LICENSE', 'README.ko.md', 'docs/ui.md', 'docs/ai.md', 'llms.txt', 'skills/flow-qa/SKILL.md', 'skills/flow-qa/references/workflow.md', 'dist/examples/demo/server.js', 'LICENSE']) {
  assert.ok(files.includes(required), `Missing runtime file: ${required}`);
}
console.log(JSON.stringify({ name: pack.name, version: pack.version, files: files.length, bytes: pack.size, bundled: pack.bundled, result: 'passed' }, null, 2));
