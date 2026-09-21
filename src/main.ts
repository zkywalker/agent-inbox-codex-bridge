import { chmod, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexBridge } from './bridge.js';
import { CodexRpc } from './rpc.js';
import { BridgeState } from './state.js';
import { describeStartupError, parseBridgeConfig } from './config.js';

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
  const rpc = new CodexRpc(config.codexBinary, undefined, config.projects[0].path);
  const bridge = new CodexBridge(config, rpc, state);
  process.once('SIGINT', () => bridge.stop()); process.once('SIGTERM', () => bridge.stop());
  try { await bridge.initialize(); console.log('[codex-bridge] ready'); await bridge.run(); }
  finally { bridge.stop(); state.close(); }
}
void main().catch(error => { console.error(`[codex-bridge] startup or runtime failed: ${describeStartupError(error)}`); process.exitCode = 1; });
