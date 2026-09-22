import { z } from 'zod';
import { BRIDGE_PLATFORMS, BRIDGE_RELEASE_REPOSITORY, type BridgePlatform, type BridgeReleaseSnapshot } from '../shared/bridge-release.js';
import { MAX_BRIDGE_MANIFEST_BYTES } from './bridge-release-schema.js';
import { MAX_BRIDGE_SIGNATURE_BYTES, verifyBridgeReleaseManifest } from './bridge-release-signature.js';

export const stableBridgeVersion = z.string().max(64).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
export function compareBridgeVersions(left: string, right: string) {
  const leftParts = stableBridgeVersion.parse(left).split('.').map(BigInt), rightParts = stableBridgeVersion.parse(right).split('.').map(BigInt);
  const index = leftParts.findIndex((part, position) => part !== rightParts[position]);
  return index < 0 ? 0 : leftParts[index] > rightParts[index] ? 1 : -1;
}
export function bridgeAssetUrl(version: string, name: string) {
  stableBridgeVersion.parse(version);
  if (!['manifest.json', 'manifest.sig.json', ...BRIDGE_PLATFORMS.map(platform => `codex-bridge-${version}-${platform}.tar.gz`)].includes(name)) throw new Error('Invalid Bridge asset');
  return `https://github.com/${BRIDGE_RELEASE_REPOSITORY}/releases/download/v${version}/${name}`;
}
export async function fetchBridgeAsset(url: string, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const initial = new URL(url);
  if (initial.origin !== 'https://github.com' || initial.username || initial.password || initial.search || initial.hash || !initial.pathname.startsWith(`/${BRIDGE_RELEASE_REPOSITORY}/releases/download/`)) throw new Error('Invalid Bridge download source');
  let target = url;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    const response = await fetcher(target, { redirect: 'manual', signal, headers: { Accept: 'application/octet-stream' }, credentials: 'omit', cache: 'no-store' });
    if (response.status === 200) return response;
    await response.body?.cancel();
    if (![301, 302, 303, 307, 308].includes(response.status)) throw new Error('Bridge download unavailable');
    const location = response.headers.get('location');
    if (!location) throw new Error('Bridge redirect missing');
    const next = new URL(location, target);
    if (next.protocol !== 'https:' || next.username || next.password || next.hash || next.hostname !== 'release-assets.githubusercontent.com' || next.port) throw new Error('Untrusted Bridge redirect');
    target = next.href;
  }
  throw new Error('Too many Bridge redirects');
}
export async function readBridgeResponse(response: Response, maximum: number, signal: AbortSignal) {
  if (!response.body) throw new Error('Bridge response has no body');
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) { await response.body.cancel(); throw new Error('Bridge response exceeds size limit'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > maximum) throw new Error('Bridge response exceeds size limit');
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks);
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

const releaseSchema = z.object({
  draft: z.literal(false), prerelease: z.literal(false), tag_name: z.string().max(65),
  assets: z.array(z.object({ name: z.string().max(200), browser_download_url: z.string().max(2048) })).max(32),
});
export class BridgeReleaseSource {
  private cache: { snapshot: BridgeReleaseSnapshot; checkedAt: number } | null = null;
  private pending: Promise<void> | null = null;
  private highest: { version: string; digest: string } | null = null;
  private retryAt = 0;
  private readonly shutdown = new AbortController();
  private readonly keys: string[];
  constructor(options: { trustedPublicKeys: readonly string[]; fetcher?: typeof fetch; now?: () => number; ttlMs?: number }) {
    this.keys = [...options.trustedPublicKeys];
    this.fetcher = options.fetcher ?? fetch; this.now = options.now ?? Date.now;
    this.ttlMs = Math.max(1, Math.min(options.ttlMs ?? 60_000, 60_000));
  }
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private verify(snapshot: BridgeReleaseSnapshot, currentVersion = '0.0.0') {
    return verifyBridgeReleaseManifest(Buffer.from(snapshot.manifest, 'base64'), Buffer.from(snapshot.signature, 'base64'), { trustedPublicKeys: this.keys, currentVersion, now: this.now() });
  }
  private async refresh() {
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(15_000)]);
    const response = await this.fetcher(`https://api.github.com/repos/${BRIDGE_RELEASE_REPOSITORY}/releases/latest`, { redirect: 'error', signal, credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
    if (response.status !== 200) { await response.body?.cancel(); throw new Error('Bridge release discovery unavailable'); }
    const release = releaseSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBridgeResponse(response, 256 * 1024, signal))));
    if (!release.tag_name.startsWith('v')) throw new Error('Invalid Bridge release tag');
    const version = stableBridgeVersion.parse(release.tag_name.slice(1));
    const names = ['manifest.json', 'manifest.sig.json', ...BRIDGE_PLATFORMS.map(platform => `codex-bridge-${version}-${platform}.tar.gz`)];
    for (const name of names) {
      const matches = release.assets.filter(asset => asset.name === name);
      if (matches.length !== 1 || matches[0].browser_download_url !== bridgeAssetUrl(version, name)) throw new Error('Bridge release asset mismatch');
    }
    const manifest = await readBridgeResponse(await fetchBridgeAsset(bridgeAssetUrl(version, 'manifest.json'), signal, this.fetcher), MAX_BRIDGE_MANIFEST_BYTES, signal);
    const signature = await readBridgeResponse(await fetchBridgeAsset(bridgeAssetUrl(version, 'manifest.sig.json'), signal, this.fetcher), MAX_BRIDGE_SIGNATURE_BYTES, signal);
    const snapshot = { manifest: manifest.toString('base64'), signature: signature.toString('base64') };
    const verified = this.verify(snapshot);
    if (verified.manifest.version !== version) throw new Error('Bridge manifest does not match release');
    if (this.highest && (compareBridgeVersions(version, this.highest.version) < 0 || version === this.highest.version && verified.manifestSha256 !== this.highest.digest)) throw new Error('Bridge release regressed or changed');
    signal.throwIfAborted();
    this.highest = { version, digest: verified.manifestSha256 };
    this.cache = { snapshot, checkedAt: this.now() };
  }
  async latest(currentVersion: string, platform: BridgePlatform) {
    stableBridgeVersion.parse(currentVersion); z.enum(BRIDGE_PLATFORMS).parse(platform);
    this.shutdown.signal.throwIfAborted();
    if (!this.keys.length) throw new Error('Bridge release trust is not configured');
    let fresh = false;
    if (this.cache && this.now() >= this.cache.checkedAt && this.now() - this.cache.checkedAt < this.ttlMs) {
      try { this.verify(this.cache.snapshot); fresh = true; } catch { this.cache = null; }
    }
    if (!fresh) {
      if (this.now() < this.retryAt) throw new Error('Bridge release discovery is backing off');
      if (!this.pending) this.pending = this.refresh().catch(error => { this.cache = null; this.retryAt = this.now() + 15_000; throw error; }).finally(() => { this.pending = null; });
      await this.pending;
    }
    this.shutdown.signal.throwIfAborted();
    if (!this.cache) throw new Error('Bridge release unavailable');
    const verified = this.verify(this.cache.snapshot);
    const available = compareBridgeVersions(verified.manifest.version, currentVersion) > 0;
    return { available, checkedAt: new Date(this.cache.checkedAt).toISOString(), expiresAt: verified.manifest.expiresAt, version: verified.manifest.version, manifestSha256: verified.manifestSha256, signerKeyId: verified.signerKeyId, asset: available ? verified.manifest.assets.find(asset => asset.platform === platform)! : null, snapshot: available ? { ...this.cache.snapshot } : null };
  }
  close() { this.shutdown.abort(); this.cache = null; }
}
