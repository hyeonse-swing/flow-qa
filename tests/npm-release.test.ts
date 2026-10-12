import test from 'node:test';
import assert from 'node:assert/strict';
const { registryMetadata, registryVersion, registryConfirmed, registryConfirmedForCommit, releaseDecision, validateManifest } = await import(new URL('../scripts/npm-release.mjs', import.meta.url).href);

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
  assert.throws(() => registryConfirmedForCommit('0.1.2', { ...metadata, gitHead: publishingSha }, '0.1.2', true, 'bad-sha'), /GITHUB_SHA must/);
  assert.throws(() => registryConfirmedForCommit('0.1.2', { ...metadata, gitHead: publishingSha }, '0.1.2', true, '0'.repeat(40)), /GITHUB_SHA must/);
});
