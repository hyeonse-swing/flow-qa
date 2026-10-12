import test from 'node:test';
import assert from 'node:assert/strict';
const { registryVersion, registryConfirmed, releaseDecision, validateManifest } = await import(new URL('../scripts/npm-release.mjs', import.meta.url).href);

const manifest = (version: string) => ({ name: '@ihyeon/flow-qa', version });
const lock = (version: string) => ({ ...manifest(version), packages: { '': manifest(version) } });

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

test('published rerun confirms its exact version even after latest advances', () => {
  assert.equal(registryConfirmed('0.1.2', '0.1.2', '0.1.3', false), true);
  assert.equal(registryConfirmed('0.1.2', '0.1.2', '0.1.3', true), false);
  assert.equal(registryConfirmed('0.1.2', null, '0.1.3', false), false);
});
