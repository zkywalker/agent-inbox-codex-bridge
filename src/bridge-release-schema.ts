import { z } from 'zod';
import { BRIDGE_PLATFORMS, BRIDGE_RELEASE_REPOSITORY, type BridgeReleaseManifest } from '../shared/bridge-release.js';

export const MAX_BRIDGE_ASSET_BYTES = 256 * 1024 * 1024;
export const MAX_BRIDGE_MANIFEST_BYTES = 16 * 1024;
export const MAX_BRIDGE_MANIFEST_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const releaseVersion = z.string().max(64).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const assetSchema = z.object({
  platform: z.enum(BRIDGE_PLATFORMS),
  name: z.string().min(1).max(200),
  size: z.number().int().positive().max(MAX_BRIDGE_ASSET_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.literal(BRIDGE_RELEASE_REPOSITORY),
  version: releaseVersion,
  publishedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  assets: z.array(assetSchema).length(BRIDGE_PLATFORMS.length),
}).strict().refine(manifest => new Set(manifest.assets.map(asset => asset.platform)).size === BRIDGE_PLATFORMS.length, 'Duplicate Bridge platform')
  .refine(manifest => manifest.assets.every(asset => asset.name === `codex-bridge-${manifest.version}-${asset.platform}.tar.gz`), 'Invalid Bridge asset name');

export function parseUntrustedBridgeManifest(bytes: Uint8Array, options: { currentVersion: string; now: number }): BridgeReleaseManifest {
  if (bytes.byteLength > MAX_BRIDGE_MANIFEST_BYTES) throw new Error('Bridge manifest exceeds size limit');
  if (!Number.isFinite(options.now)) throw new Error('Invalid manifest verification time');
  const manifest = manifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  const publishedAt = Date.parse(manifest.publishedAt), expiresAt = Date.parse(manifest.expiresAt);
  if (publishedAt > options.now || expiresAt <= options.now || expiresAt <= publishedAt || expiresAt - publishedAt > MAX_BRIDGE_MANIFEST_AGE_MS) throw new Error('Bridge manifest is expired or has an invalid validity interval');
  const current = releaseVersion.parse(options.currentVersion).split('.').map(BigInt);
  const target = manifest.version.split('.').map(BigInt);
  const difference = target.findIndex((part, index) => part !== current[index]);
  if (difference < 0 || target[difference] < current[difference]) throw new Error('Bridge target must be newer than the current version');
  return manifest;
}
