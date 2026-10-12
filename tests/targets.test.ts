import assert from 'node:assert/strict';
import test from 'node:test';
import { targetSchema } from '../src/schema.ts';
import { reportTarget, targetFingerprint, targetKind, targetLabel } from '../src/targets.ts';

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
