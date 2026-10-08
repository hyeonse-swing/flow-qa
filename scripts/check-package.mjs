import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const npmCLI = process.env.npm_execpath;
assert.ok(npmCLI, 'Run via npm run check:package.');
const result = spawnSync(process.execPath, [npmCLI, 'pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
const [pack] = JSON.parse(result.stdout);
const files = pack.files.map((file) => file.path);
for (const file of files) {
  assert.ok(file.startsWith('dist/') || file.startsWith('licenses/') || /^docs\/[^/]+\.md$/.test(file) || file.startsWith('node_modules/@hyeonse/design-system/') || ['package.json', 'README.md', 'README.ko.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'].includes(file), `Unexpected package file: ${file}`);
  assert.ok(!/(^|\/)(\.env(?:\.|$)|\.npmrc|\.flowqa|\.git)(\/|$)/.test(file), `Private file in package: ${file}`);
  if (file.startsWith('dist/')) assert.ok(!file.endsWith('.ts'), `Uncompiled TypeScript: ${file}`);
}
for (const required of ['dist/bin/flow-qa.mjs', 'dist/src/cli.js', 'dist/src/ui/entry.js', 'dist/src/ui/public/index.html', 'dist/src/ui/public/app.js', 'dist/src/ui/public/i18n.js', 'README.ko.md', 'docs/ui.md', 'dist/examples/demo/server.js', 'LICENSE', 'node_modules/@hyeonse/design-system/LICENSE', 'node_modules/@hyeonse/design-system/dist/tokens.css', 'node_modules/@hyeonse/design-system/dist/preferences.js']) {
  assert.ok(files.includes(required), `Missing runtime file: ${required}`);
}
assert.ok(pack.bundled.includes('@hyeonse/design-system'), 'Design system must be bundled for installation without Git.');
console.log(JSON.stringify({ name: pack.name, version: pack.version, files: files.length, bytes: pack.size, bundled: pack.bundled, result: 'passed' }, null, 2));
