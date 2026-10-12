import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireMobileDevice, mobileReadiness, type MobileDevice } from '../src/mobile-runtime.ts';
import { targetSchema } from '../src/schema.ts';

const target = targetSchema.parse({ kind: 'mobile', platform: 'ios', bundleId: 'com.example.app', device: 'iPhone' });
if (target.kind !== 'mobile') throw new Error('Expected mobile test target.');

test('read-only readiness requires the explicitly named booted device', async () => {
  let calls = 0;
  const list = async (platform: string): Promise<MobileDevice[]> => {
    calls++;
    assert.equal(platform, 'ios');
    return [{ platform: 'ios', id: 'UDID-1', name: 'iPhone', booted: true }];
  };
  assert.deepEqual(await mobileReadiness(target, list), { ready: true, deviceId: 'UDID-1', sdkDevice: 'iPhone' });
  assert.equal(calls, 1);
  assert.deepEqual(await mobileReadiness({ ...target, device: 'UDID-1' }, list), { ready: true, deviceId: 'UDID-1', sdkDevice: 'iPhone' });
  assert.deepEqual(await mobileReadiness({ ...target, device: 'missing' }, list),
    { ready: false, reason: 'Selected mobile device is unavailable or not booted.' });
  assert.deepEqual(await mobileReadiness(target, async () => [{ platform: 'ios', id: 'UDID-1', name: 'iPhone', booted: false }]),
    { ready: false, reason: 'Selected mobile device is unavailable or not booted.' });
});

test('readiness blocks ambiguous names, claims and unavailable inventory', async () => {
  const duplicate = [
    { platform: 'ios', id: 'UDID-1', name: 'iPhone', booted: true },
    { platform: 'ios', id: 'UDID-2', name: 'iPhone', booted: true },
  ];
  assert.deepEqual(await mobileReadiness(target, async () => duplicate),
    { ready: false, reason: 'Selected mobile device name is ambiguous. Use an ID.' });
  assert.deepEqual(await mobileReadiness({ ...target, device: 'UDID-2' }, async () => duplicate),
    { ready: false, reason: 'Selected mobile device cannot be uniquely addressed by this runtime.' });
  assert.deepEqual(await mobileReadiness(target, async () => [{ ...duplicate[0]!, claimedBy: { session: 'other', workspace: '/tmp/other' } }]),
    { ready: false, reason: 'Selected mobile device is in use.' });
  assert.deepEqual(await mobileReadiness(target, async () => { throw new Error('No SDK'); }),
    { ready: false, reason: 'Mobile runtime or device inventory is unavailable.' });
});

test('SDK selector uses supported simulator IDs or a unique physical-device name', async () => {
  const iosId = '01234567-89AB-CDEF-0123-456789ABCDEF';
  assert.deepEqual(await mobileReadiness(target, async () => [{ platform: 'ios', id: iosId, name: 'iPhone', booted: true }]),
    { ready: true, deviceId: iosId, sdkDevice: iosId });
  const android = targetSchema.parse({ kind: 'mobile', platform: 'android', bundleId: 'com.example.app', device: 'R58N123' });
  if (android.kind !== 'mobile') throw new Error('Expected Android target.');
  const phone: MobileDevice = { platform: 'android', id: 'android:R58N123', name: 'Pixel 9', identifiers: { serial: 'R58N123' }, booted: true };
  assert.deepEqual(await mobileReadiness(android, async () => [phone]),
    { ready: true, deviceId: phone.id, sdkDevice: 'Pixel 9' });
  assert.deepEqual(await mobileReadiness(android, async () => [phone, { ...phone, id: 'android:R58N456', identifiers: { serial: 'R58N456' } }]),
    { ready: false, reason: 'Selected mobile device cannot be uniquely addressed by this runtime.' });
  assert.deepEqual(await mobileReadiness(android, async () => [phone, { ...phone, id: 'android:R58N456', name: 'pixel_9', identifiers: { serial: 'R58N456' } }]),
    { ready: false, reason: 'Selected mobile device cannot be uniquely addressed by this runtime.' });
  const emulator = { ...phone, id: 'emulator-5554', name: 'Pixel', identifiers: { serial: 'emulator-5554' } };
  assert.deepEqual(await mobileReadiness({ ...android, device: 'emulator-5554' }, async () => [emulator]),
    { ready: true, deviceId: 'emulator-5554', sdkDevice: 'emulator-5554' });
});

test('in-process lock uses canonical platform and device ID and releases', () => {
  const release = acquireMobileDevice('ios', 'UDID-1');
  assert.ok(release);
  assert.equal(acquireMobileDevice('ios', 'UDID-1'), undefined);
  const androidRelease = acquireMobileDevice('android', 'UDID-1');
  assert.ok(androidRelease);
  release();
  const reacquired = acquireMobileDevice('ios', 'UDID-1');
  assert.ok(reacquired);
  reacquired();
  androidRelease();
});
