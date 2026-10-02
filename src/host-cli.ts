import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { configContract, migrateBridgeConfig, parseBridgeConfig } from './config.js';
import { acquireHostLocks, diagnoseHost, diagnoseSupervisor, HostHealth, type HostCode } from './host-safety.js';

export async function loadHostConfig(path: string) {
  if (!isAbsolute(path) || !(await stat(path)).isFile()) throw new Error('config_invalid: an absolute private configuration file is required');
  if (process.platform !== 'win32' && ((await stat(path)).mode & 0o077)) throw new Error('config_invalid: private configuration requires mode 0600');
  const config = parseBridgeConfig(JSON.parse(await readFile(path, 'utf8')));
  const gateway = new URL(config.gatewayUrl);
  if (gateway.username || gateway.password || gateway.search || gateway.hash || gateway.pathname !== '/' || (gateway.protocol !== 'https:' && !(gateway.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(gateway.hostname)))) throw new Error('config_invalid: gatewayUrl must be a secure origin');
  for (const project of [...config.projects, ...(config.projectRoots ?? [])]) {
    project.path = await realpath(project.path);
    if (!(await stat(project.path)).isDirectory()) throw new Error('config_invalid: project must be an existing directory');
  }
  const binaries = isAbsolute(config.codexBinary) ? [config.codexBinary] : (process.env.PATH ?? '').split(delimiter).map(directory => join(directory, config.codexBinary));
  let executable = false;
  for (const binary of binaries) try { await access(binary, constants.X_OK); if ((await stat(binary)).isFile()) { executable = true; break; } } catch {}
  if (!executable) throw new Error('codex_unavailable');
  return config;
}

export async function prepareHost(args = process.argv.slice(2)) {
  if (args[0] === '--config-contract') { console.log(JSON.stringify(configContract)); return null; }
  const command = args[0]?.startsWith('--') ? args[0] : 'run';
  const path = command === 'run' ? args[0] : args[1];
  if (!path || !['run', '--validate', '--diagnose', '--migrate-config'].includes(command)) throw new Error('config_invalid: expected [--validate|--diagnose|--migrate-config] /absolute/private-config.json');
  if (command === '--diagnose') {
    const root = args[2] ?? process.env.AGENT_INBOX_BRIDGE_ROOT;
    console.log(JSON.stringify({ ...await diagnoseHost(path), ...(root ? { supervisor: await diagnoseSupervisor(root) } : {}) })); return null;
  }
  let config;
  try { config = await loadHostConfig(path); }
  catch (error) {
    if (command === 'run') {
      const health = new HostHealth(path, undefined, notifyHealth);
      try { await health.start(); await health.finish(error instanceof Error && error.message === 'codex_unavailable' ? 'codex_unavailable' : 'config_invalid', 78, true); } catch {}
    }
    throw error;
  }
  if (command === '--migrate-config') {
    if (!args[2] || !isAbsolute(args[2])) throw new Error('config_invalid: migration requires a new absolute output file; original is never overwritten');
    const migrated = migrateBridgeConfig(JSON.parse(await readFile(path, 'utf8')));
    await writeFile(args[2], `${JSON.stringify(migrated, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log('[codex-bridge] migration validated: configVersion=1; original preserved'); return null;
  }
  if (config.configVersion === undefined) console.error('[codex-bridge] legacy configVersion=0 accepted; run --migrate-config with a new output file to stamp version 1');
  if (command === '--validate') { console.log('[codex-bridge] configuration valid; contract=1'); return null; }
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const lock = await acquireHostLocks(config);
  const health = new HostHealth(path, undefined, notifyHealth);
  try { await health.start(); } catch (error) { await lock.release(); throw error; }
  return { path, config, health, lock };
}

function notifyHealth(record: { code: HostCode; instanceId: string | null; startupFailures: number; lastExitCode: number | null; lastRegisteredAt: string | null }) {
  console.error(`[codex-host] ${record.code}`);
  if (process.send && process.env.BRIDGE_SUPERVISOR_NONCE) process.send({ type: 'bridge-health', nonce: process.env.BRIDGE_SUPERVISOR_NONCE, ...record }, () => {});
}

export async function finishHost(host: NonNullable<Awaited<ReturnType<typeof prepareHost>>>, error?: unknown) {
  const uncertain = error instanceof Error && error.message === 'Bridge shutdown requires host recovery';
  await host.health.flush();
  const current = await diagnoseHost(host.path);
  const code: HostCode = uncertain || error instanceof Error && error.message === 'Native update requires host recovery' ? 'recovery_required' : error ? ['auth_failed', 'instance_conflict', 'gateway_unreachable'].includes(current.code) ? current.code as HostCode : 'codex_unavailable' : current.code === 'codex_unavailable' ? 'codex_unavailable' : 'stopped';
  const exitCode = code === 'stopped' ? 0 : 1;
  await host.health.finish(code, exitCode, !!error && !current.instanceId);
  if (exitCode) process.exitCode = exitCode;
  if (!uncertain) await host.lock.release();
}
