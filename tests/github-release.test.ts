import test from 'node:test';
import assert from 'node:assert/strict';

const { ensureGitHubRelease, latestDecision, validateReleaseInput } = await import(new URL('../scripts/github-release.mjs', import.meta.url).href);

const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const input = { repository: 'hyeonse-swing/flow-qa', version: '0.1.3', tag: 'v0.1.3', sha };
const env = {
  FLOWQA_RELEASE_VERSION: '0.1.3',
  FLOWQA_RELEASE_CANDIDATE: 'true',
  GITHUB_SHA: sha,
  GITHUB_REPOSITORY: input.repository,
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/heads/main',
  GH_TOKEN: 'test-token',
};

type GhResult = { status: number; stdout: string; stderr: string };
type FixtureOptions = {
  tagSha?: string;
  annotatedCommit?: string;
  release?: Record<string, unknown>;
  latestTag?: string;
  readTagError?: GhResult;
};

function fixture(options: FixtureOptions = {}) {
  const calls: string[][] = [];
  let tagObject: { type: string; sha: string } | null = options.tagSha
    ? { type: options.annotatedCommit ? 'tag' : 'commit', sha: options.tagSha }
    : null;
  const found = (value: unknown): GhResult => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  const missing: GhResult = { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
  const run = (args: string[]): GhResult => {
    calls.push(args);
    if (args[0] === 'api' && args[1] === '-X' && args[2] === 'GET') {
      const path = args[3];
      if (path?.endsWith('/git/ref/tags/v0.1.3')) {
        if (options.readTagError) return options.readTagError;
        return tagObject ? found({ ref: 'refs/tags/v0.1.3', object: tagObject }) : missing;
      }
      if (path?.endsWith('/git/tags/' + options.tagSha)) {
        return found({ object: { type: 'commit', sha: options.annotatedCommit } });
      }
      if (path?.endsWith('/releases/tags/v0.1.3')) return options.release ? found(options.release) : missing;
      if (path?.endsWith('/releases/latest')) return options.latestTag ? found({ tag_name: options.latestTag }) : missing;
    }
    if (args[0] === 'api' && args[1] === '-X' && args[2] === 'POST' && args[3]?.endsWith('/git/refs')) {
      assert.ok(args.includes('ref=refs/tags/v0.1.3'));
      assert.ok(args.includes(`sha=${sha}`));
      tagObject = { type: 'commit', sha };
      return found({ ref: 'refs/tags/v0.1.3', object: tagObject });
    }
    if (args[0] === 'release' && args[1] === 'create') {
      return { status: 0, stdout: 'https://github.com/hyeonse-swing/flow-qa/releases/tag/v0.1.3\n', stderr: '' };
    }
    throw new Error(`Unexpected gh command: ${args.join(' ')}`);
  };
  return { calls, run };
}

test('release accepts only the approved main push, matching version, repository and SHA', () => {
  assert.deepEqual(validateReleaseInput(env, '0.1.3'), input);
  assert.throws(() => validateReleaseInput({ ...env, GITHUB_EVENT_NAME: 'pull_request' }, '0.1.3'), /push to main/);
  assert.throws(() => validateReleaseInput({ ...env, GITHUB_REF: 'refs/heads/feature' }, '0.1.3'), /push to main/);
  assert.throws(() => validateReleaseInput({ ...env, GITHUB_REPOSITORY: 'someone/flow-qa' }, '0.1.3'), /release repository/);
  assert.throws(() => validateReleaseInput({ ...env, FLOWQA_RELEASE_CANDIDATE: 'false' }, '0.1.3'), /npm release gate/);
  assert.throws(() => validateReleaseInput({ ...env, GITHUB_SHA: 'main' }, '0.1.3'), /commit SHA/);
  assert.throws(() => validateReleaseInput({ ...env, FLOWQA_RELEASE_VERSION: '0.1.3-beta.1' }, '0.1.3-beta.1'), /plain X.Y.Z/);
  assert.throws(() => validateReleaseInput(env, '0.1.2'), /matching package.json/);
});

test('new version creates an exact-SHA tag and release with npm, changelog and generated notes', () => {
  const { calls, run } = fixture({ latestTag: 'v0.1.2' });
  const result = ensureGitHubRelease(input, run);
  assert.equal(result.status, 'created');
  assert.equal(result.latest, true);
  const create = calls.find(args => args[0] === 'release' && args[1] === 'create');
  assert.ok(create);
  assert.ok(create.includes('--target'));
  assert.equal(create[create.indexOf('--target') + 1], sha);
  assert.ok(create.includes('--verify-tag'));
  assert.ok(create.includes('--generate-notes'));
  assert.ok(create.includes('--latest=true'));
  const notes = create[create.indexOf('--notes') + 1];
  assert.ok(notes);
  assert.match(notes, /npmjs\.com\/package\/@ihyeon\/flow-qa\/v\/0\.1\.3/);
  assert.match(notes, new RegExp(`blob/${sha}/docs/releases\\.md`));
  assert.ok(calls.some(args => args[0] === 'api' && args[2] === 'POST'));
});

test('rerun preserves an existing release and accepts a matching annotated tag', () => {
  const { calls, run } = fixture({
    tagSha: otherSha,
    annotatedCommit: sha,
    release: { tag_name: 'v0.1.3', target_commitish: sha, draft: false, prerelease: false, html_url: 'https://example.test/release' },
  });
  assert.equal(ensureGitHubRelease(input, run).status, 'existing');
  assert.equal(calls.some(args => args[0] === 'release' || args[2] === 'POST'), false);
  assert.equal(calls.some(args => args[3]?.endsWith('/releases/latest')), false);
});

test('existing tag or release at a different commit stops without mutation', () => {
  const tagCollision = fixture({ tagSha: otherSha });
  assert.throws(() => ensureGitHubRelease(input, tagCollision.run), /different commit/);
  assert.equal(tagCollision.calls.some(args => args[0] === 'release' || args[2] === 'POST'), false);

  const releaseCollision = fixture({
    tagSha: sha,
    release: { tag_name: 'v0.1.3', target_commitish: otherSha, draft: false, prerelease: false },
  });
  assert.throws(() => ensureGitHubRelease(input, releaseCollision.run), /metadata that does not match/);
  assert.equal(releaseCollision.calls.some(args => args[0] === 'release' || args[2] === 'POST'), false);
});

test('historical rerun does not replace newer latest and unknown latest tag avoids promotion', () => {
  assert.deepEqual(latestDecision('0.1.3', 'v0.1.4'), { latest: false, reason: 'current latest release is the same or newer' });
  assert.equal(latestDecision('0.1.3', 'release-2026').latest, false);
  const { calls, run } = fixture({ latestTag: 'v0.1.4' });
  assert.equal(ensureGitHubRelease(input, run).latest, false);
  assert.ok(calls.find(args => args[0] === 'release')?.includes('--latest=false'));
});

test('an API failure other than 404 is not mistaken for a missing tag', () => {
  const { calls, run } = fixture({ readTagError: { status: 1, stdout: '', stderr: 'gh: server error (HTTP 500)' } });
  assert.throws(() => ensureGitHubRelease(input, run), /HTTP 500/);
  assert.equal(calls.some(args => args[0] === 'release' || args[2] === 'POST'), false);
});
