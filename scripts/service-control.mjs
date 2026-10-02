import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, realpath, stat, mkdir, cp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { preflight } from '../supervisor/host-preflight.mjs';

export async function controlService({ root, config, plist, action, confirmedIdle = false, run = (command, args) => execFileSync(command, args, { stdio: 'ignore' }) }) {
  if (!['start', 'restart'].includes(action) || process.platform !== 'darwin') throw new Error('macOS start/restart only');
  root = await realpath(resolve(root)); config = await realpath(resolve(config)); plist = await realpath(resolve(plist));
  if ((await stat(plist)).mode & 0o077) throw new Error('Private service file requires mode 0600');
  const directory = await realpath(join(root, 'current'));
  await preflight(directory, config);
  const extract = key => execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim();
  const label = extract('Label');
  if (!/^com\.agent-inbox\.[a-zA-Z0-9.-]+$/.test(label)) throw new Error('Unexpected service label');
  const supervisor = await realpath(extract('ProgramArguments.1'));
  const supervisors = [join(directory, 'supervisor/supervisor.mjs'), join(root, 'supervisor/supervisor.mjs')];
  if (!supervisors.includes(supervisor) || await realpath(extract('EnvironmentVariables.AGENT_INBOX_BRIDGE_CONFIG')) !== config || await realpath(extract('EnvironmentVariables.AGENT_INBOX_BRIDGE_ROOT')) !== root) throw new Error('Service target does not match preflight');
  const domain = `gui/${process.getuid()}`, service = `${domain}/${label}`;
  const loaded = spawnSync('launchctl', ['print', service], { stdio: 'ignore' }).status === 0;
  if (action === 'start' && loaded) throw new Error('Service already loaded; not starting another instance');
  if (action === 'restart') {
    if (!confirmedIdle) throw new Error('Restart requires --confirmed-idle and owner-controlled ingress');
    const privateConfig = JSON.parse(await readFile(config, 'utf8'));
    const database = new DatabaseSync(join(privateConfig.stateDir, 'state.sqlite'), { readOnly: true });
    try {
      const sessions = database.prepare('SELECT body FROM sessions').all().map(row => JSON.parse(row.body));
      if (sessions.some(session => ['running', 'waiting', 'unknown'].includes(session.state)) || database.prepare("SELECT count(*) AS count FROM inputs WHERE state='processing'").get().count || database.prepare('SELECT count(*) AS count FROM outgoing WHERE revision>sent_revision').get().count) throw new Error('Bridge is busy or uncertain; service unchanged');
    } finally { database.close(); }
    if (loaded) run('launchctl', ['bootout', service]);
    const deadline = Date.now() + 45_000;
    for (;;) {
      try { await stat(join(root, 'state/supervisor.lock')); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
      if (Date.now() >= deadline) throw new Error('Previous Supervisor cleanup unconfirmed; no replacement started');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const backup = join(root, 'backups', `service-${Date.now()}`);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    await cp(config, join(backup, 'config.json'), { errorOnExist: true, force: false });
    await cp(plist, join(backup, 'service.plist'), { errorOnExist: true, force: false });
    await cp(privateConfig.stateDir, join(backup, 'bridge-state'), { recursive: true, errorOnExist: true, force: false });
    await writeFile(join(backup, 'version.json'), JSON.stringify({ directory }), { flag: 'wx', mode: 0o600 });
  }
  run('launchctl', ['bootstrap', domain, plist]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  const [action, root, config, plist, confirmation] = process.argv.slice(2);
  controlService({ action, root, config, plist, confirmedIdle: confirmation === '--confirmed-idle' }).catch(() => {
    console.error('[codex-service] operation refused; verify preflight, service identity and idle state; do not bypass the guard'); process.exitCode = 1;
  });
}
