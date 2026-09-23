import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, lstat, realpath, link, rename, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { BridgePlatform, BridgeReleaseSnapshot, BridgeReleaseAsset } from '../shared/bridge-release.js';
import { MAX_BRIDGE_MANIFEST_BYTES } from './bridge-release-schema.js';
import { MAX_BRIDGE_SIGNATURE_BYTES, verifyBridgeReleaseManifest } from './bridge-release-signature.js';
import { bridgeAssetUrl, fetchBridgeAsset } from './bridge-release-source.js';

export function hostBridgePlatform(): BridgePlatform {
  const platform = `${process.platform}-${process.arch}`;
  if (platform !== 'darwin-x64' && platform !== 'darwin-arm64' && platform !== 'linux-x64') throw new Error('Unsupported Bridge host platform');
  return platform;
}
export function verifyBridgeSnapshot(snapshot: BridgeReleaseSnapshot, keys: readonly string[], currentVersion: string, now = Date.now()) {
  const decode = (text: string, maximum: number) => {
    if (typeof text !== 'string' || text.length > Math.ceil(maximum / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('Invalid Bridge snapshot encoding');
    const bytes = Buffer.from(text, 'base64');
    if (bytes.toString('base64') !== text || bytes.length > maximum) throw new Error('Invalid Bridge snapshot encoding');
    return bytes;
  };
  return verifyBridgeReleaseManifest(decode(snapshot.manifest, MAX_BRIDGE_MANIFEST_BYTES), decode(snapshot.signature, MAX_BRIDGE_SIGNATURE_BYTES), { trustedPublicKeys: keys, currentVersion, now });
}
async function installationRoot(root: string) {
  if (await realpath(root) !== resolve(root) || !(await lstat(root)).isDirectory()) throw new Error('Bridge root must be a real directory');
  return resolve(root);
}
async function privateDirectory(root: string, name: string) {
  const directory = join(root, name);
  await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new Error('Unsafe Bridge directory');
  return directory;
}
async function hashArchive(path: string, asset: BridgeReleaseAsset, signal: AbortSignal) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== asset.size) throw new Error('Bridge archive changed');
    const hash = createHash('sha256'); let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      signal.throwIfAborted(); size += chunk.length;
      if (size > asset.size) throw new Error('Bridge archive size mismatch');
      hash.update(chunk);
    }
    if (size !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error('Bridge archive digest mismatch');
    signal.throwIfAborted();
  } finally { await file.close(); }
}
export interface BridgeHostUpdateOptions {
  root: string;
  currentVersion: string;
  trustedPublicKeys: readonly string[];
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  now?: () => number;
}
export interface BridgeRetryProof {
  operationId: string;
  manifestSha256: string;
  fromVersion: string;
  targetVersion: string;
}
async function quarantineFailedCandidate(root: string, target: string, downloaded: { version: string; manifestSha256: string }, options: BridgeHostUpdateOptions, proof?: BridgeRetryProof) {
  if (!proof || proof.targetVersion !== downloaded.version || proof.fromVersion !== options.currentVersion || proof.manifestSha256 !== downloaded.manifestSha256) throw new Error('Bridge target version already exists');
  const state = await privateDirectory(root, 'state');
  const file = await open(join(state, 'bridge-update.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let journal;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096) throw new Error('Invalid Supervisor journal');
    journal = JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
  if (journal.operationId !== proof.operationId || journal.status !== 'failed' || journal.error !== 'startup_failed' || journal.fromVersion !== proof.fromVersion || journal.toVersion !== proof.targetVersion || journal.manifestSha256 !== proof.manifestSha256) throw new Error('Bridge rollback not confirmed');
  for (const name of ['current', 'previous']) {
    if (!(await lstat(join(root, name))).isSymbolicLink() || await realpath(join(root, name)) !== join(root, 'versions', options.currentVersion)) throw new Error('Bridge candidate may still be in use');
  }
  const prepared = await verifyPreparedBridge(root, downloaded.version, proof.operationId, options.trustedPublicKeys, options.currentVersion);
  if (prepared.manifestSha256 !== proof.manifestSha256) throw new Error('Bridge retry receipt differs from rollback');
  options.signal?.throwIfAborted();
  const quarantine = await privateDirectory(root, 'quarantine');
  await rename(target, join(quarantine, `${downloaded.version}-${proof.operationId}-${randomUUID()}`));
  for (const directory of [quarantine, join(root, 'versions'), root]) {
    const handle = await open(directory, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  }
}
export async function downloadBridgeRelease(snapshot: BridgeReleaseSnapshot, options: BridgeHostUpdateOptions) {
  const verified = verifyBridgeSnapshot(snapshot, options.trustedPublicKeys, options.currentVersion, options.now?.() ?? Date.now());
  const platform = hostBridgePlatform(), asset = verified.manifest.assets.find(candidate => candidate.platform === platform)!;
  const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(10 * 60_000)]);
  signal.throwIfAborted();
  const root = await installationRoot(options.root), downloads = await privateDirectory(root, 'downloads');
  const archive = join(downloads, `${verified.manifest.version}-${platform}-${asset.sha256}.tar.gz`);
  const result = { archive, asset, platform, version: verified.manifest.version, manifestSha256: verified.manifestSha256, snapshot: { ...snapshot } };
  try { await hashArchive(archive, asset, signal); return result; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = join(downloads, `.part-${randomUUID()}`);
  const response = await fetchBridgeAsset(bridgeAssetUrl(result.version, asset.name), signal, options.fetcher);
  const declared = response.headers.get('content-length');
  if (!response.body || declared && (!/^\d+$/.test(declared) || Number(declared) !== asset.size) || ![null, 'identity'].includes(response.headers.get('content-encoding'))) {
    await response.body?.cancel(); throw new Error('Invalid Bridge archive response');
  }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporary, 'wx', 0o600);
    const hash = createHash('sha256'); let size = 0;
    while (true) {
      signal.throwIfAborted(); const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > asset.size) throw new Error('Bridge archive exceeds signed size');
      hash.update(chunk.value); await file.writeFile(chunk.value);
    }
    if (size !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error('Bridge archive digest mismatch');
    signal.throwIfAborted(); await file.sync(); await file.close(); file = undefined;
    try { await link(temporary, archive); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await hashArchive(archive, asset, signal); }
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
    await file?.close(); await rm(temporary, { force: true });
  }
}

async function runBridgeProgram(script: string, args: string[], directory: string, signal: AbortSignal, timeoutMs: number) {
  signal.throwIfAborted();
  await new Promise<void>((resolveValidation, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: directory, stdio: 'ignore', detached: true, shell: false });
    let settled = false, interrupted = false;
    let killDeadline: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(killDeadline); signal.removeEventListener('abort', stop);
      if (error) reject(error); else resolveValidation();
    };
    const stop = () => {
      if (interrupted || settled) return;
      interrupted = true;
      if (child.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      killDeadline = setTimeout(() => finish(Object.assign(new Error('Bridge subprocess cleanup unconfirmed'), { code: 'bridge_process_unconfirmed' })), 5000);
    };
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener('abort', stop, { once: true });
    child.once('error', () => finish(new Error('Bridge bundle validation unavailable')));
    child.once('close', code => finish(code === 0 && !signal.aborted && !interrupted ? undefined : new Error('Bridge subprocess failed')));
    if (signal.aborted) stop();
  });
}

export async function validateBridgeBundle(directory: string, configPath: string, signal: AbortSignal) {
  await runBridgeProgram(join(directory, 'dist/src/main.js'), ['--validate', configPath], directory, signal, 30_000);
}

export async function prepareBridgeRelease(operationId: string, snapshot: BridgeReleaseSnapshot, options: BridgeHostUpdateOptions & { configPath: string; retryProof?: BridgeRetryProof }) {
  z.string().uuid().parse(operationId);
  const downloaded = await downloadBridgeRelease(snapshot, options);
  const root = await installationRoot(options.root), versions = await privateDirectory(root, 'versions');
  const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(10 * 60_000)]);
  const target = join(versions, downloaded.version), staging = join(versions, `.staging-${operationId}`);
  let exists = false;
  try { await lstat(target); exists = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (exists) {
    if (options.retryProof?.operationId === operationId) throw new Error('Bridge retry requires a new operation');
    await quarantineFailedCandidate(root, target, downloaded, { ...options, signal }, options.retryProof);
  }
  await mkdir(staging, { mode: 0o700 });
  try {
    const expectedRoot = `codex-bridge-${downloaded.version}-${downloaded.platform}`;
    await runBridgeProgram(fileURLToPath(new URL('./bridge-unpack.js', import.meta.url)), [downloaded.archive, staging, expectedRoot, String(downloaded.asset.size), downloaded.asset.sha256], staging, signal, 10 * 60_000);
    for (const required of ['dist/src/main.js', 'package.json', 'package-lock.json', 'bridge-version.json', 'node_modules/zod/package.json', 'supervisor/supervisor.mjs']) {
      const path = join(staging, required);
      if (!(await lstat(path)).isFile() || await realpath(path) !== path) throw new Error('Incomplete Bridge bundle');
    }
    z.object({ version: z.literal(downloaded.version) }).strict().parse(JSON.parse(await readFile(join(staging, 'bridge-version.json'), 'utf8')));
    await validateBridgeBundle(staging, options.configPath, signal);
    verifyBridgeSnapshot(snapshot, options.trustedPublicKeys, options.currentVersion, options.now?.() ?? Date.now());
    const receipt = { operationId, version: downloaded.version, manifestSha256: downloaded.manifestSha256, snapshot };
    const marker = await open(join(staging, '.bridge-update.json'), 'wx', 0o600);
    try { await marker.writeFile(JSON.stringify(receipt)); await marker.sync(); } finally { await marker.close(); }
    signal.throwIfAborted();
    await rename(staging, target);
    return receipt;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'bridge_process_unconfirmed') await rm(staging, { recursive: true, force: true }); throw error; }
}

export async function verifyPreparedBridge(root: string, version: string, operationId: string, keys: readonly string[], currentVersion: string) {
  z.string().uuid().parse(operationId);
  z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/).max(64).parse(version);
  const directory = join(await installationRoot(root), 'versions', version);
  if (await realpath(directory) !== directory) throw new Error('Unsafe prepared Bridge directory');
  const file = await open(join(directory, '.bridge-update.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let receipt;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 32 * 1024) throw new Error('Invalid Bridge preparation receipt');
    receipt = z.object({ operationId: z.literal(operationId), version: z.literal(version), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/), snapshot: z.object({ manifest: z.string().max(24 * 1024), signature: z.string().max(4096) }).strict() }).strict().parse(JSON.parse(await file.readFile('utf8')));
  } finally { await file.close(); }
  const verified = verifyBridgeSnapshot(receipt.snapshot, keys, currentVersion);
  if (verified.manifest.version !== version || verified.manifestSha256 !== receipt.manifestSha256) throw new Error('Prepared Bridge identity mismatch');
  return { directory, ...receipt };
}
