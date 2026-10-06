import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexBridge } from './bridge.js';
import { CodexRpc } from './rpc.js';
import { BridgeState } from './state.js';
import { describeStartupError, startupExitCode } from './config.js';
import { z } from 'zod';
import { bridgeManagementDriver } from './bridge-management-update.js';
import { prepareHost, finishHost } from './host-cli.js';
import { LocalHealth } from './local-health.js';

async function main() {
  const host = await prepareHost();
  if (!host) return;
  const localHealth = new LocalHealth('codex', host.path);
  await localHealth.start();
  try { await run(host, localHealth); await finishHost(host); }
  catch (error) { await finishHost(host, error); throw error; }
  finally { await localHealth.stop(); }
}
async function run(host: NonNullable<Awaited<ReturnType<typeof prepareHost>>>, localHealth: LocalHealth) {
  const { config, path, health } = host;
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const state = new BridgeState(join(config.stateDir, 'state.sqlite'));
  if (process.platform !== 'win32') await chmod(join(config.stateDir, 'state.sqlite'), 0o600);
  for (const connection of state.managedConnections()) process.env[connection.envKey] = connection.apiKey;
  const priorUpdate = state.nativeUpdate();
  if (priorUpdate && ['updating', 'restarting', 'verifying', 'uncertain'].includes(priorUpdate.status)) {
    if (priorUpdate.status !== 'uncertain') state.saveNativeUpdate({ ...priorUpdate, status: 'uncertain', error: 'update_interrupted', updatedAt: new Date().toISOString() });
    state.close();
    console.error('[codex-bridge] native update requires host recovery; no Codex process started; see docs/codex.md');
    process.exitCode = 1;
    throw new Error('Native update requires host recovery');
  }
  const nonce = process.env.BRIDGE_SUPERVISOR_NONCE;
  let bridgeUpdater;
  try {
    if (nonce && process.send && process.env.AGENT_INBOX_BRIDGE_UPDATES === '1' && process.env.AGENT_INBOX_BRIDGE_ROOT && process.env.BRIDGE_RELEASE_PUBLIC_KEYS_FILE) {
      const keys = z.array(z.string().min(1).max(4096)).min(1).max(16).parse(JSON.parse(await readFile(process.env.BRIDGE_RELEASE_PUBLIC_KEYS_FILE, 'utf8')));
      bridgeUpdater = bridgeManagementDriver(process.env.AGENT_INBOX_BRIDGE_ROOT, path, keys, message => new Promise((resolveSent, reject) => {
        if (!process.connected || !process.send) { reject(new Error('Supervisor disconnected')); return; }
        process.send({ ...message, nonce }, error => error ? reject(new Error('Supervisor IPC unavailable')) : resolveSent());
      }));
    }
  } catch { state.close(); throw new Error('Invalid Bridge update trust configuration'); }
  const rpc = new CodexRpc(config.codexBinary, undefined, config.projects[0].path);
  const bridge = new CodexBridge(config, rpc, state, undefined, bridgeUpdater);
  bridge.onLocalConnection = (connected, status) => connected ? localHealth.success() : localHealth.failure(status);
  bridge.onHealth = event => health.observe(event);
  bridge.gateway.onHealth = event => {
    health.observe(event);
    if (event.code === 'auth_failed') localHealth.failure(401);
    else if (event.code === 'instance_conflict') localHealth.failure(409);
  };
  const probe = setInterval(() => void bridge.probeHealth(), 15_000).unref();
  let shutdown: Promise<void> | undefined;
  const stop = () => { shutdown ??= bridge.stopAndWait(); void shutdown.catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  process.on('message', (message: any) => {
    if (!nonce || message?.nonce !== nonce) return;
    if (message.type === 'bridge-supervisor-stop') stop();
    if (message.type === 'bridge-update-result') bridge.observeBridgeUpdate(message.result);
  });
  try {
    try { bridge.bridgeVersion = z.object({ version: z.string().max(64).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/) }).strict().parse(JSON.parse(await readFile(new URL('../../bridge-version.json', import.meta.url), 'utf8'))).version; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    bridge.resumeBridgeUpdate(process.env.BRIDGE_UPDATE_OPERATION_ID || null);
    await bridge.initialize();
    const identity = bridge.supervisorIdentity();
    if (process.send && nonce && identity) process.send({ type: 'bridge-ready', nonce, operationId: process.env.BRIDGE_UPDATE_OPERATION_ID || null, ...identity });
    console.log('[codex-bridge] ready'); await bridge.run();
  } finally {
    clearInterval(probe);
    try {
      await bridge.stopAndWait(); state.close();
      if (process.send && nonce) process.send({ type: 'bridge-stopped', nonce }, () => { if (process.connected) process.disconnect(); });
    } catch { state.close(); throw new Error('Bridge shutdown requires host recovery'); }
  }
}
void main().catch(error => { console.error(`[codex-bridge] startup or runtime failed: ${describeStartupError(error)}`); process.exitCode = startupExitCode(error); });
