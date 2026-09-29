#!/usr/bin/env node
import { mkdir, open, readFile, unlink, realpath, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BridgeUpdateController } from './update-controller.mjs';
import { ManagedBridgeChild } from './managed-child.mjs';
import { preflight, RestartPolicy } from './host-preflight.mjs';

async function main() {
  const rootInput = process.env.AGENT_INBOX_BRIDGE_ROOT || process.argv[2];
  const configInput = process.env.AGENT_INBOX_BRIDGE_CONFIG || process.argv[3];
  if (!rootInput || !configInput) throw new Error('Supervisor root and config are required');
  const root = resolve(rootInput), config = resolve(configInput);
  if (await realpath(root) !== root) throw new Error('Supervisor root must be canonical');
  await mkdir(join(root, 'state'), { recursive: true, mode: 0o700 });
  if (await realpath(join(root, 'state')) !== join(root, 'state')) throw new Error('Unsafe Supervisor state');
  const lockPath = join(root, 'state', 'supervisor.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.sync(); await lock.close();
  let stopping = false, restartTimer, pausedTimer, stableTimer;
  const retry = new RestartPolicy();
  const healthPath = join(root, 'state', 'supervisor-health.json');
  let health = { code: 'starting', startupFailures: 0, lastExitCode: null, lastRegisteredAt: null, instanceId: null, pid: process.pid, updatedAt: new Date().toISOString() };
  try { const previous = JSON.parse(await readFile(healthPath, 'utf8')); if (Number.isSafeInteger(previous.startupFailures)) health.startupFailures = previous.startupFailures; } catch {}
  let healthWrites = Promise.resolve();
  const report = (code, patch = {}) => {
    health = { ...health, ...patch, code, updatedAt: new Date().toISOString() };
    const text = JSON.stringify(health);
    healthWrites = healthWrites.then(async () => { await writeFile(`${healthPath}.tmp`, text, { mode: 0o600 }); await rename(`${healthPath}.tmp`, healthPath); });
    void healthWrites.catch(() => console.error('[bridge-supervisor] recovery_required: health persistence unavailable'));
    console.error(`[bridge-supervisor] ${code}`);
  };
  const pause = (code, increment = true) => { report(code, { startupFailures: health.startupFailures + (increment ? 1 : 0) }); pausedTimer ??= setInterval(() => {}, 60_000); };
  const start = async (version, operationId = null) => {
    if (stopping) throw new Error('Supervisor is stopping');
    await preflight(join(root, 'versions', version), config);
    if (stopping) throw new Error('Supervisor is stopping');
    return driver.start(version, operationId);
  };
  const driver = new ManagedBridgeChild({ root, config,
    onExit(exit) {
      clearTimeout(stableTimer); stableTimer = undefined;
      report(driver.stopped ? 'stopped' : 'recovery_required', { lastExitCode: exit.code });
      if (stopping || controller.busy) return;
      if (!driver.stopped) { pause('recovery_required'); return; }
      const delay = retry.next();
      report('codex_unavailable', { startupFailures: health.startupFailures + 1, retryAfterMs: delay });
      if (delay === null) { pause('recovery_required', false); return; }
      restartTimer = setTimeout(() => void controller.read().then(async record => {
        if (!stopping && !controller.busy && record?.status !== 'uncertain') await start(await controller.currentVersion());
      }).catch(error => pause(error.message === 'config_invalid' ? 'config_invalid' : 'recovery_required')), delay);
    },
    onHealth(message) {
      if (!['starting', 'healthy', 'stopped', 'not_started', 'config_invalid', 'codex_unavailable', 'auth_failed', 'instance_conflict', 'gateway_unreachable', 'recovery_required'].includes(message.code)) return;
      report(message.code, { lastRegisteredAt: message.lastRegisteredAt, instanceId: message.instanceId });
      if (message.code === 'healthy' && !stableTimer) stableTimer = setTimeout(() => { retry.failures = 0; stableTimer = undefined; }, 60_000).unref();
      if (message.code !== 'healthy') { clearTimeout(stableTimer); stableTimer = undefined; }
    },
    onUpdate(message) {
      if (message.type === 'bridge-update-status') {
        void controller.read().then(result => driver.notifyUpdate(result)).catch(() => console.error('[bridge-supervisor] journal unavailable'));
        return;
      }
      if (stopping || process.env.AGENT_INBOX_BRIDGE_UPDATES !== '1' || controller.busy) return;
      void controller.switchTo({ operationId: message.operationId, version: message.version })
        .then(result => { driver.notifyUpdate(result); console.log(`[bridge-supervisor] update ${result.status}`); })
        .catch(() => console.error('[bridge-supervisor] update refused; inspect host state'));
    },
  });
  const controller = new BridgeUpdateController({ root, stop: () => driver.stop(), start, validate: async (version, operationId, fromVersion) => {
    if (process.env.AGENT_INBOX_BRIDGE_UPDATES !== '1' || !process.env.BRIDGE_RELEASE_PUBLIC_KEYS_FILE) throw new Error('Bridge updates are disabled');
    const keys = JSON.parse(await readFile(process.env.BRIDGE_RELEASE_PUBLIC_KEYS_FILE, 'utf8'));
    if (!Array.isArray(keys) || !keys.length || keys.length > 16 || keys.some(key => typeof key !== 'string' || key.length > 4096)) throw new Error('Invalid Bridge trust configuration');
    const module = await import(pathToFileURL(join(root, 'versions', fromVersion, 'dist/src/bridge-host-update.js')).href);
    const prepared = await module.verifyPreparedBridge(root, version, operationId, keys, fromVersion);
    await module.validateBridgeBundle(prepared.directory, config, AbortSignal.timeout(30_000));
    return prepared;
  } });
  await controller.initialize();
  const prior = await controller.read();
  if (prior && !['failed', 'succeeded'].includes(prior.status)) {
    if (process.argv[4] !== '--recover-clean-host') throw new Error('Supervisor recovery requires a confirmed clean host');
    const recovered = await controller.recover();
    if (recovered?.status === 'uncertain') throw new Error('Supervisor recovery remains uncertain');
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    stopping = true; clearTimeout(restartTimer); clearInterval(pausedTimer); clearTimeout(stableTimer);
    void driver.stop().then(async () => {
      if (controller.busy) { console.error('[bridge-supervisor] update still settling; lock retained'); process.exitCode = 1; return; }
      report('stopped'); await healthWrites; await unlink(lockPath); process.exit(0);
    }).catch(() => { console.error('[bridge-supervisor] shutdown unconfirmed; lock retained'); process.exitCode = 1; });
  });
  if (driver.closed) try { await start(await controller.currentVersion()); }
  catch (error) { pause(['config_invalid', 'codex_unavailable'].includes(error.message) ? error.message : 'recovery_required'); }
}
void main().catch(error => {
  console.error(`[bridge-supervisor] ${error.code === 'EEXIST' ? 'instance_conflict' : 'recovery_required'}: startup refused; inspect root, lock and journal; no automatic restart`);
  process.exitCode = 1;
  setInterval(() => {}, 60_000);
});
