#!/usr/bin/env node
import { mkdir, open, readFile, unlink, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BridgeUpdateController } from './update-controller.mjs';
import { ManagedBridgeChild } from './managed-child.mjs';

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
  let stopping = false, restartTimer;
  const driver = new ManagedBridgeChild({ root, config,
    onExit() {
      if (stopping || controller.busy) return;
      if (!driver.stopped) { console.error('[bridge-supervisor] child cleanup unconfirmed; host recovery required'); return; }
      restartTimer = setTimeout(() => void controller.read().then(async record => {
        if (!stopping && !controller.busy && record?.status !== 'uncertain') await driver.start(await controller.currentVersion());
      }).catch(() => console.error('[bridge-supervisor] restart refused')), 5000);
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
  const controller = new BridgeUpdateController({ root, stop: () => driver.stop(), start: (version, operationId) => {
    if (stopping) throw new Error('Supervisor is stopping');
    return driver.start(version, operationId);
  }, validate: async (version, operationId, fromVersion) => {
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
    stopping = true; clearTimeout(restartTimer);
    void driver.stop().then(async () => {
      if (controller.busy) { console.error('[bridge-supervisor] update still settling; lock retained'); process.exitCode = 1; return; }
      await unlink(lockPath); process.exit(0);
    }).catch(() => { console.error('[bridge-supervisor] shutdown unconfirmed; lock retained'); process.exitCode = 1; });
  });
  if (driver.closed) await driver.start(await controller.currentVersion());
}
void main().catch(() => { console.error('[bridge-supervisor] startup refused; check root, lock and update journal without starting a second Bridge'); process.exitCode = 1; });
