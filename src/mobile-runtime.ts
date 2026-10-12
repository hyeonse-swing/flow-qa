import type { Target } from './schema.ts';

export type MobileTarget = Extract<Target, { kind: 'mobile' }>;

export interface MobileDevice {
  platform: string;
  id: string;
  name: string;
  booted?: boolean;
  identifiers?: { udid?: string; serial?: string };
  claimedBy?: { session: string; workspace: string };
}

export type ListMobileDevices = (platform: MobileTarget['platform']) => Promise<readonly MobileDevice[]>;
export type MobileReadiness = { ready: true; deviceId: string; sdkDevice: string } | { ready: false; reason: string };

const INVENTORY_TIMEOUT_MS = 10_000;
const IOS_UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const ANDROID_EMULATOR = /^emulator-\d+$/;
const activeDevices = new Set<string>();

// agent-device's --device name lookup is case-insensitive and treats _ as a space.
const normalizedName = (value: string): string => value.replaceAll('_', ' ').replace(/\s+/g, ' ').trim().toLowerCase();

async function localDevices(platform: MobileTarget['platform']): Promise<readonly MobileDevice[]> {
  // Resolve both packages only when a user starts a native run. Listing devices
  // reads the local inventory; it does not boot a simulator or install an app.
  await import('@e2e-dev/mobile');
  const { createAgentDeviceClient } = await import('agent-device');
  return createAgentDeviceClient().devices.list({ platform });
}

async function boundedInventory(list: ListMobileDevices, platform: MobileTarget['platform']): Promise<readonly MobileDevice[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      list(platform),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Mobile device inventory timed out.')), INVENTORY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A read-only gate before e2e's prepare hook, which otherwise may boot a device. */
export async function mobileReadiness(target: MobileTarget, listDevices: ListMobileDevices = localDevices): Promise<MobileReadiness> {
  let inventory: readonly MobileDevice[];
  try { inventory = await boundedInventory(listDevices, target.platform); }
  catch { return { ready: false, reason: 'Mobile runtime or device inventory is unavailable.' }; }

  const platformDevices = inventory.filter((device) => device.platform === target.platform);
  const ids = platformDevices.filter((device) => device.id === target.device
    || device.identifiers?.udid === target.device || device.identifiers?.serial === target.device);
  const matches = ids.length ? ids : platformDevices.filter((device) => device.name === target.device);
  if (matches.length > 1) return { ready: false, reason: 'Selected mobile device name is ambiguous. Use an ID.' };
  const selected = matches[0];
  if (!selected || selected.booted !== true) return { ready: false, reason: 'Selected mobile device is unavailable or not booted.' };
  if (selected.claimedBy) return { ready: false, reason: 'Selected mobile device is in use.' };
  // The installed mobile engine recognizes only simulator UDIDs and emulator
  // serials as IDs. Other identifiers must be passed as an unambiguous name.
  const nativeId = target.platform === 'ios' ? selected.identifiers?.udid ?? selected.id : selected.identifiers?.serial ?? selected.id;
  const acceptsId = target.platform === 'ios' ? IOS_UDID.test(nativeId) : ANDROID_EMULATOR.test(nativeId);
  const sdkDevice = acceptsId ? nativeId : selected.name;
  if (!sdkDevice || (!acceptsId && platformDevices.filter((device) => normalizedName(device.name) === normalizedName(selected.name)).length > 1)) {
    return { ready: false, reason: 'Selected mobile device cannot be uniquely addressed by this runtime.' };
  }
  return { ready: true, deviceId: selected.id, sdkDevice };
}

/** Avoid simultaneous runs on the same device within this process. */
export function acquireMobileDevice(platform: MobileTarget['platform'], deviceId: string): (() => void) | undefined {
  const key = JSON.stringify([platform, deviceId]);
  if (activeDevices.has(key)) return undefined;
  activeDevices.add(key);
  return () => { activeDevices.delete(key); };
}
