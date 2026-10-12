import { createHash } from 'node:crypto';
import type { Target } from './schema.ts';

export type ReportTarget =
  | { name: string; url: string; kind?: 'web' }
  | { name: string; kind: 'mobile'; platform: 'ios' | 'android'; bundleId: string; device: string };

export function targetKind(target: Target): 'web' | 'mobile' {
  return target.kind === 'mobile' ? 'mobile' : 'web';
}

export function targetLabel(target: Target | ReportTarget): string {
  return target.kind === 'mobile'
    ? `${target.platform} · ${target.bundleId} · ${target.device}`
    : target.url;
}

export function targetFingerprint(target: Target | ReportTarget): string {
  const identity = target.kind === 'mobile'
    ? { kind: 'mobile', platform: target.platform, bundleId: target.bundleId, device: target.device }
    : { kind: 'web', url: target.url };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export function reportTarget(name: string, target: Target): ReportTarget {
  return target.kind === 'mobile'
    ? { name, kind: 'mobile', platform: target.platform, bundleId: target.bundleId, device: target.device }
    : { name, url: target.url, ...(target.kind === 'web' ? { kind: 'web' as const } : {}) };
}
