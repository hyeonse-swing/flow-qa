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
  if (metadata) {
    if (!validCommitSha(metadata.gitHead)) throw new Error('npm registry metadata is missing a valid gitHead');
    if (metadata.gitHead.toLowerCase() !== githubSha.toLowerCase()) {
      throw new Error('npm registry gitHead does not match GITHUB_SHA');
    }
  }
  return registryConfirmed(version, metadata?.version, latest, requireLatest);
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

export function isRetryableRegistryError(error) {
  if (/^npm registry (?:latest|\d+\.\d+\.\d+): HTTP (?:429|5\d\d)$/.test(error?.message ?? '')) return true;
  const transientCodes = new Set(['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (current.name === 'TimeoutError' || transientCodes.has(current.code)) return true;
  }
  return false;
}

export async function verifyPublishedRelease(version, githubSha, requireLatest, request = fetch,
  pause = ms => new Promise(done => setTimeout(done, ms)), now = () => performance.now()) {
  const deadline = now() + 10 * 60_000;
  for (;;) {
    try {
      const published = await registryMetadata(version, true, request);
      if (published) registryConfirmedForCommit(version, published, null, false, githubSha);
      const latest = requireLatest ? await registryVersion('latest', true, request) : null;
      if (registryConfirmedForCommit(version, published, latest, requireLatest, githubSha)) return;
      if (requireLatest && latest !== null && greater(latest, version)) {
        throw new Error(`npm latest ${latest} already exceeds ${version}`);
      }
    } catch (error) {
      if (!isRetryableRegistryError(error)) throw error;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(`npm registry did not confirm ${NAME}@${version}${requireLatest ? ' as latest' : ''} within 10 minutes`);
    }
    console.log(`${NAME}@${version}: exact version or latest is still propagating; retrying`);
    await pause(Math.min(20_000, remaining));
  }
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
  await verifyPublishedRelease(version, githubSha, requireLatest);
  console.log(`npm registry confirms ${NAME}@${version}${requireLatest ? ' and latest' : ''} at GITHUB_SHA`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
