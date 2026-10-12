import { execFileSync } from 'node:child_process';
import { readFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = '@ihyeon/flow-qa';
const REGISTRY = 'https://registry.npmjs.org/@ihyeon%2fflow-qa';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/i;

function validCommitSha(value) {
  return typeof value === 'string' && SHA.test(value) && !/^0{40}$/.test(value);
}

function parts(version) {
  const match = VERSION.exec(version ?? '');
  if (!match) throw new Error(`Release version must be plain X.Y.Z: ${version}`);
  return match.slice(1).map(BigInt);
}

function greater(current, previous) {
  const a = parts(current);
  const b = parts(previous);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export function validateManifest(pkg, lock) {
  if (pkg.name !== NAME || lock.name !== NAME || lock.packages?.['']?.name !== NAME) {
    throw new Error(`Release package name must be ${NAME} in package.json and package-lock.json`);
  }
  parts(pkg.version);
  if (lock.version !== pkg.version || lock.packages[''].version !== pkg.version) {
    throw new Error('package.json and package-lock.json versions must match');
  }
  return pkg.version;
}

export function releaseDecision(version, previous, published, latest) {
  parts(previous);
  parts(latest);
  if (version === previous) return { shouldPublish: false, reason: 'unchanged' };
  if (!greater(version, previous)) throw new Error(`Version ${version} must increase from ${previous}`);
  if (published) return { shouldPublish: false, reason: 'already published' };
  if (!greater(version, latest)) throw new Error(`Version ${version} must exceed npm latest ${latest}`);
  return { shouldPublish: true, reason: 'new version' };
}

export function registryConfirmed(version, published, latest, requireLatest) {
  return published === version && (!requireLatest || latest === version);
}

export function registryConfirmedForCommit(version, metadata, latest, requireLatest, githubSha) {
  if (!validCommitSha(githubSha)) throw new Error('GITHUB_SHA must be a valid nonzero commit SHA');
  if (!registryConfirmed(version, metadata?.version, latest, requireLatest)) return false;
  if (!validCommitSha(metadata.gitHead)) throw new Error('npm registry metadata is missing a valid gitHead');
  if (metadata.gitHead.toLowerCase() !== githubSha.toLowerCase()) {
    throw new Error('npm registry gitHead does not match GITHUB_SHA');
  }
  return true;
}

export async function registryMetadata(suffix, allow404 = false, request = fetch) {
  const response = await request(`${REGISTRY}/${encodeURIComponent(suffix)}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (allow404 && response.status === 404) return null;
  if (!response.ok) throw new Error(`npm registry ${suffix}: HTTP ${response.status}`);
  const metadata = await response.json();
  if (!metadata || metadata.name !== NAME || typeof metadata.version !== 'string' || (suffix !== 'latest' && metadata.version !== suffix)) {
    throw new Error(`npm registry ${suffix}: invalid package metadata`);
  }
  return metadata;
}

export async function registryVersion(suffix, allow404 = false, request = fetch) {
  const metadata = await registryMetadata(suffix, allow404, request);
  return metadata?.version ?? null;
}

async function main() {
  const mode = process.argv[2];
  if (mode !== 'gate' && mode !== 'verify') throw new Error('Usage: npm-release.mjs gate|verify');
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const version = validateManifest(pkg, lock);
  if (mode === 'gate') {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const before = event.before;
    if (!/^[0-9a-f]{40}$/i.test(before ?? '') || /^0{40}$/.test(before)) {
      throw new Error('A valid push before SHA is required');
    }
    const previousPackage = JSON.parse(execFileSync('git', ['show', `${before}:package.json`], { encoding: 'utf8' }));
    if (previousPackage.name !== NAME) throw new Error('Previous package name does not match');
    if (version === previousPackage.version) {
      if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
      await appendFile(process.env.GITHUB_OUTPUT, `should_publish=false\nrelease_candidate=false\nversion=${version}\n`);
      console.log(`${version}: unchanged`);
      return;
    }
    const [published, latest] = await Promise.all([
      registryVersion(version, true),
      registryVersion('latest'),
    ]);
    const decision = releaseDecision(version, previousPackage.version, published !== null, latest);
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
    await appendFile(process.env.GITHUB_OUTPUT, `should_publish=${decision.shouldPublish}\nrelease_candidate=true\nversion=${version}\n`);
    console.log(`${version}: ${decision.reason}`);
    return;
  }
  const requireLatest = process.env.FLOWQA_REQUIRE_LATEST !== 'false';
  if (process.env.FLOWQA_REQUIRE_LATEST && !['true', 'false'].includes(process.env.FLOWQA_REQUIRE_LATEST)) {
    throw new Error('FLOWQA_REQUIRE_LATEST must be true or false');
  }
  const githubSha = process.env.GITHUB_SHA;
  if (!validCommitSha(githubSha)) throw new Error('GITHUB_SHA must be a valid nonzero commit SHA');
  for (let attempt = 1; attempt <= 15; attempt++) {
    let published;
    let latest;
    try {
      [published, latest] = await Promise.all([
        registryMetadata(version),
        requireLatest ? registryVersion('latest') : Promise.resolve(null),
      ]);
    } catch (error) {
      if (attempt === 15) throw error;
      await new Promise(done => setTimeout(done, 20_000));
      continue;
    }
    if (registryConfirmedForCommit(version, published, latest, requireLatest, githubSha)) {
      console.log(`npm registry confirms ${NAME}@${version}${requireLatest ? ' and latest' : ''} at GITHUB_SHA`);
      return;
    }
    if (attempt < 15) await new Promise(done => setTimeout(done, 20_000));
  }
  throw new Error(`npm registry did not confirm ${NAME}@${version} as latest`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
