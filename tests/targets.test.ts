import assert from 'node:assert/strict';
import test from 'node:test';
import { targetSchema } from '../src/schema.ts';
import { registrationTarget, reportTarget, targetFingerprint, targetKind, targetLabel } from '../src/targets.ts';

test('registration changes only a new bare web root and preserves an existing root spelling', () => {
  const incoming = targetSchema.parse({ url: 'http://127.0.0.1:43982/', description: 'New label' });
  const original = targetSchema.parse({ url: 'http://127.0.0.1:43982/', description: 'Old label' });
  assert.deepEqual(registrationTarget(incoming), { ...incoming, url: 'http://127.0.0.1:43982' });
  assert.deepEqual(registrationTarget(targetSchema.parse({ url: 'http://127.0.0.1:43982', description: 'New label' }), original),
    { ...original, description: 'New label' });
  assert.equal(targetFingerprint(original), targetFingerprint(registrationTarget(incoming, original)));
  for (const url of ['http://127.0.0.1:43982/path/', 'http://127.0.0.1:43982//', 'http://127.0.0.1:43983/', 'http://LOCALHOST:43982/']) {
    const target = targetSchema.parse({ url });
    assert.deepEqual(registrationTarget(target, original), { ...target, url: url === 'http://127.0.0.1:43983/' || url === 'http://LOCALHOST:43982/' ? url.slice(0, -1) : url });
  }
  const mobile = targetSchema.parse({ kind: 'mobile', platform: 'ios', bundleId: 'com.example.app', device: 'iPhone' });
  assert.deepEqual(registrationTarget(mobile, original), mobile);
  assert.notEqual(targetFingerprint(original), targetFingerprint(registrationTarget(incoming)));
});

test('legacy web target stays web and keeps its report shape', () => {
  const web = targetSchema.parse({ url: 'https://example.test', description: 'First' });
  if (web.kind === 'mobile') throw new Error('Expected web target.');
  assert.equal(targetKind(web), 'web');
  assert.equal(targetLabel(web), 'https://example.test');
  assert.deepEqual(reportTarget('demo', web), { name: 'demo', url: 'https://example.test' });
  assert.equal(targetFingerprint(web), targetFingerprint({ ...web, description: 'Second' }));
  assert.equal(targetFingerprint(web), targetFingerprint(reportTarget('renamed', web)));
  assert.notEqual(targetFingerprint(web), targetFingerprint({ ...web, url: 'https://other.test' }));
});

test('native identity includes app, platform and device, but excludes labels', () => {
  const ios = targetSchema.parse({ kind: 'mobile', platform: 'ios', bundleId: 'com.example.app', device: 'A1', description: 'Phone' });
  if (ios.kind !== 'mobile') throw new Error('Expected mobile target.');
  assert.equal(targetKind(ios), 'mobile');
  assert.equal(targetLabel(ios), 'ios · com.example.app · A1');
  assert.deepEqual(reportTarget('phone', ios), { name: 'phone', kind: 'mobile', platform: 'ios', bundleId: 'com.example.app', device: 'A1' });
  const fingerprint = targetFingerprint(ios);
  assert.equal(fingerprint, targetFingerprint(reportTarget('other', ios)));
  assert.equal(fingerprint, targetFingerprint({ ...ios, description: 'Changed' }));
  assert.notEqual(fingerprint, targetFingerprint({ ...ios, platform: 'android' as const }));
  assert.notEqual(fingerprint, targetFingerprint({ ...ios, bundleId: 'com.example.other' }));
  assert.notEqual(fingerprint, targetFingerprint({ ...ios, device: 'A2' }));
});
