import test from 'node:test';
import assert from 'node:assert/strict';
const { registryMetadata, registryVersion, registryConfirmed, registryConfirmedForCommit, releaseDecision, validateManifest, verifyPublishedRelease } = await import(new URL('../scripts/npm-release.mjs', import.meta.url).href);

const manifest = (version: string) => ({ name: '@ihyeon/flow-qa', version });
const lock = (version: string) => ({ ...manifest(version), packages: { '': manifest(version) } });
const publishingSha = 'e9fa6389d551f1dcb8111b2270d8a855c6208c20';

test('release requires matching package and lock metadata', () => {
  assert.equal(validateManifest(manifest('0.1.2'), lock('0.1.2')), '0.1.2');
  assert.throws(() => validateManifest(manifest('0.1.2'), lock('0.1.1')), /versions must match/);
  assert.throws(() => validateManifest(manifest('0.1.2'), { ...lock('0.1.2'), name: 'other' }), /name must/);
  assert.throws(() => validateManifest(manifest('0.1.2-beta.1'), lock('0.1.2-beta.1')), /plain X.Y.Z/);
});

test('release decision accepts a new stable version and skips unchanged or published versions', () => {
  assert.deepEqual(releaseDecision('0.1.1', '0.1.1', true, '0.1.1'), { shouldPublish: false, reason: 'unchanged' });
  assert.deepEqual(releaseDecision('0.1.2', '0.1.1', false, '0.1.1'), { shouldPublish: true, reason: 'new version' });
  assert.deepEqual(releaseDecision('0.1.2', '0.1.1', true, '0.1.2'), { shouldPublish: false, reason: 'already published' });
});

test('release rejects a downgrade against Git or npm latest', () => {
  assert.throws(() => releaseDecision('0.1.1', '0.1.2', false, '0.1.1'), /must increase/);
  assert.throws(() => releaseDecision('0.1.2', '0.1.1', false, '0.1.3'), /must exceed npm latest/);
});

test('registry treats only an exact 404 as unpublished', async () => {
  const respond = (status: number) => async () => ({ ok: status === 200, status, json: async () => manifest('0.1.2') });
  assert.equal(await registryVersion('0.1.2', true, respond(404)), null);
  await assert.rejects(registryVersion('0.1.2', true, respond(500)), /HTTP 500/);
  assert.equal(await registryVersion('0.1.2', false, respond(200)), '0.1.2');
  await assert.rejects(registryVersion('0.1.2', true, async () => { throw new Error('network down'); }), /network down/);
  await assert.rejects(registryVersion('0.1.2', false, async () => ({ ok: true, status: 200, json: async () => manifest('0.1.1') })), /invalid package metadata/);
});

test('exact-version registry metadata retains the published source SHA', async () => {
  const metadata = { ...manifest('0.1.2'), gitHead: publishingSha };
  assert.deepEqual(await registryMetadata('0.1.2', false, async () => ({
    ok: true, status: 200, json: async () => metadata,
  })), metadata);
  await assert.rejects(registryMetadata('0.1.2', false, async () => ({
    ok: true, status: 200, json: async () => manifest('0.1.1'),
  })), /invalid package metadata/);
});

test('published rerun confirms its exact version even after latest advances', () => {
  assert.equal(registryConfirmed('0.1.2', '0.1.2', '0.1.3', false), true);
  assert.equal(registryConfirmed('0.1.2', '0.1.2', '0.1.3', true), false);
  assert.equal(registryConfirmed('0.1.2', null, '0.1.3', false), false);
  const metadata = { ...manifest('0.1.2'), gitHead: publishingSha };
  assert.equal(registryConfirmedForCommit('0.1.2', metadata, '0.1.3', false, publishingSha), true);
  assert.equal(registryConfirmedForCommit('0.1.2', metadata, '0.1.3', true, publishingSha), false);
  assert.equal(registryConfirmedForCommit('0.1.2', metadata, '0.1.2', true, publishingSha.toUpperCase()), true);
});

test('registry confirmation fails closed when gitHead is missing, invalid, or different', () => {
  const metadata = manifest('0.1.2');
  assert.throws(() => registryConfirmedForCommit('0.1.2', metadata, '0.1.2', true, publishingSha), /valid gitHead/);
  assert.throws(() => registryConfirmedForCommit('0.1.2', { ...metadata, gitHead: 'not-a-sha' }, '0.1.2', true, publishingSha), /valid gitHead/);
  assert.throws(() => registryConfirmedForCommit('0.1.2', { ...metadata, gitHead: 123 }, '0.1.2', true, publishingSha), /valid gitHead/);
  assert.throws(() => registryConfirmedForCommit('0.1.2', { ...metadata, gitHead: '0'.repeat(40) }, '0.1.2', true, publishingSha), /valid gitHead/);
  assert.throws(() => registryConfirmedForCommit('0.1.2', { ...metadata, gitHead: 'a'.repeat(40) }, '0.1.2', true, publishingSha), /does not match GITHUB_SHA/);
  assert.throws(() => registryConfirmedForCommit('0.1.2', { ...metadata, gitHead: 'a'.repeat(40) }, '0.1.1', true, publishingSha), /does not match GITHUB_SHA/);
  assert.throws(() => registryConfirmedForCommit('0.1.2', { ...metadata, gitHead: publishingSha }, '0.1.2', true, 'bad-sha'), /GITHUB_SHA must/);
  assert.throws(() => registryConfirmedForCommit('0.1.2', { ...metadata, gitHead: publishingSha }, '0.1.2', true, '0'.repeat(40)), /GITHUB_SHA must/);
});

test('verify waits beyond the former 4m40s limit for exact 404 and lagging latest', async () => {
  let elapsed = 0;
  let waits = 0;
  const metadata = { ...manifest('0.1.2'), gitHead: publishingSha };
  const respond = (status: number, body: unknown) => ({ ok: status === 200, status, json: async () => body });
  const request = async (url: string) => {
    if (url.endsWith('/0.1.2')) return elapsed < 60_000 ? respond(404, null) : respond(200, metadata);
    if (url.endsWith('/latest')) return elapsed < 20_000 ? respond(404, null) :
      respond(200, elapsed < 5 * 60_000 ? manifest('0.1.1') : metadata);
    throw new Error(`Unexpected registry URL: ${url}`);
  };
  await verifyPublishedRelease('0.1.2', publishingSha, true, request,
    async (ms: number) => { elapsed += ms; waits++; }, () => elapsed);
  assert.equal(elapsed, 5 * 60_000);
  assert.equal(waits, 15);
});

test('verify stops after about 10 minutes if exact version remains unavailable', async () => {
  let elapsed = 0;
  let calls = 0;
  const request = async (url: string) => {
    calls++;
    return url.endsWith('/latest')
      ? { ok: true, status: 200, json: async () => manifest('0.1.1') }
      : { ok: false, status: 404, json: async () => null };
  };
  await assert.rejects(verifyPublishedRelease('0.1.2', publishingSha, true, request,
    async (ms: number) => { elapsed += ms; }, () => elapsed), /within 10 minutes/);
  assert.equal(elapsed, 10 * 60_000);
  assert.equal(calls, 62);
});

test('verify retries 429, 5xx, and network timeouts within the same deadline', async () => {
  const metadata = { ...manifest('0.1.2'), gitHead: publishingSha };
  const respond = (status: number, body: unknown = metadata) => ({ ok: status === 200, status, json: async () => body });
  const timeout = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
  });
  let exactCalls = 0;
  let latestCalls = 0;
  let elapsed = 0;
  await verifyPublishedRelease('0.1.2', publishingSha, true, async (url: string) => {
    if (url.endsWith('/0.1.2')) {
      exactCalls++;
      if (exactCalls === 1) return respond(429);
      if (exactCalls === 2) return respond(503);
      if (exactCalls === 3) throw timeout;
      return respond(200);
    }
    latestCalls++;
    return latestCalls === 1 ? respond(502) : respond(200);
  }, async (ms: number) => { elapsed += ms; }, () => elapsed);
  assert.equal(exactCalls, 5);
  assert.equal(latestCalls, 2);
  assert.equal(elapsed, 80_000);
});

test('verify fails immediately on permanent responses, invalid metadata, and wrong gitHead', async () => {
  const metadata = { ...manifest('0.1.2'), gitHead: publishingSha };
  const respond = (status: number, body: unknown) => ({ ok: status === 200, status, json: async () => body });
  for (const [exact, latest, message] of [
    [respond(401, null), respond(200, manifest('0.1.1')), /HTTP 401/],
    [respond(403, null), respond(200, manifest('0.1.1')), /HTTP 403/],
    [respond(200, metadata), respond(403, null), /HTTP 403/],
    [respond(200, { ...metadata, gitHead: 'a'.repeat(40) }), respond(200, manifest('0.1.1')), /does not match GITHUB_SHA/],
    [respond(200, metadata), respond(200, manifest('0.1.3')), /already exceeds/],
    [respond(200, manifest('0.1.1')), respond(200, manifest('0.1.1')), /invalid package metadata/],
    [{ ok: true, status: 200, json: async () => { throw new SyntaxError('bad JSON'); } }, respond(200, manifest('0.1.1')), /bad JSON/],
  ] as const) {
    let waits = 0;
    await assert.rejects(verifyPublishedRelease('0.1.2', publishingSha, true,
      async (url: string) => url.endsWith('/latest') ? latest : exact,
      async () => { waits++; }, () => 0), message);
    assert.equal(waits, 0);
  }
  let waits = 0;
  await assert.rejects(verifyPublishedRelease('0.1.2', publishingSha, true,
    async () => { throw new Error('network down'); }, async () => { waits++; }, () => 0), /network down/);
  assert.equal(waits, 0);
});

test('verify of an existing version needs its exact source but need not be latest', async () => {
  const metadata = { ...manifest('0.1.2'), gitHead: publishingSha };
  let calls = 0;
  await verifyPublishedRelease('0.1.2', publishingSha, false, async (url: string) => {
    assert.ok(url.endsWith('/0.1.2'));
    calls++;
    return { ok: true, status: 200, json: async () => metadata };
  }, async () => { throw new Error('unexpected retry'); }, () => 0);
  assert.equal(calls, 1);
});
