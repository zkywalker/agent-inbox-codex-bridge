import { chmod, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexBridge } from './bridge.js';
import { CodexRpc } from './rpc.js';
import { BridgeState } from './state.js';
import { describeStartupError, parseBridgeConfig } from './config.js';
import { z } from 'zod';
import { bridgeManagementDriver } from './bridge-management-update.js';

async function main() {
  const validateOnly = process.argv[2] === '--validate';
  const path = validateOnly ? process.argv[3] : process.argv[2];
  if (!path) throw new Error('Usage: node dist-codex/adapters/codex/main.js [--validate] /absolute/path/to/private-config.json');
  if (process.platform !== 'win32' && ((await stat(path)).mode & 0o077)) throw new Error('Private bridge config must have mode 0600');
  const config = parseBridgeConfig(JSON.parse(await readFile(path, 'utf8')));
  for (const project of [...config.projects, ...(config.projectRoots ?? [])]) {
    project.path = await realpath(project.path);
    if (!(await stat(project.path)).isDirectory()) throw new Error('Configured project is not a directory');
  }
  if (validateOnly) { console.log(`[codex-bridge] configuration valid: ${path}`); return; }
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
    return;
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
    try {
      await bridge.stopAndWait(); state.close();
      if (process.send && nonce) process.send({ type: 'bridge-stopped', nonce }, () => { if (process.connected) process.disconnect(); });
    } catch { state.close(); throw new Error('Bridge shutdown requires host recovery'); }
  }
}
void main().catch(error => { console.error(`[codex-bridge] startup or runtime failed: ${describeStartupError(error)}`); process.exitCode = 1; });
