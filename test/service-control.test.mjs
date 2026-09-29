import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { controlService } from '../scripts/service-control.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('a symlinked service entrypoint executes validation instead of silently exiting', async context => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bridge-service-link-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const link = join(root, 'service.mjs');
  await symlink(fileURLToPath(new URL('../scripts/service-control.mjs', import.meta.url)), link);
  assert.throws(() => execFileSync(process.execPath, [link, 'invalid-action'], { stdio: 'pipe' }), error => error.status === 1 && error.stderr.toString().includes('operation refused'));
});

test('service preflight accepts the fixed Supervisor and rejects unrelated entrypoints without starting a service', { skip: process.platform !== 'darwin' }, async context => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bridge-service-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const version = join(root, 'versions/0.1.12');
  await mkdir(join(version, 'dist/src'), { recursive: true });
  await mkdir(join(root, 'supervisor'));
  await writeFile(join(version, 'dist/src/main.js'), 'process.exit(0);');
  await writeFile(join(root, 'supervisor/supervisor.mjs'), '');
  await writeFile(join(root, 'unrelated.mjs'), '');
  await symlink('versions/0.1.12', join(root, 'current'));
  const config = join(root, 'config.json'), plist = join(root, 'service.plist');
  await writeFile(config, '{}', { mode: 0o600 });
  const definition = { Label: `com.agent-inbox.test-${randomUUID()}`, ProgramArguments: [process.execPath, join(root, 'supervisor/supervisor.mjs')], EnvironmentVariables: { AGENT_INBOX_BRIDGE_CONFIG: config, AGENT_INBOX_BRIDGE_ROOT: root } };
  await writeFile(plist, JSON.stringify(definition), { mode: 0o600 });
  const calls = [];
  await controlService({ root, config, plist, action: 'start', run: (...args) => calls.push(args) });
  assert.deepEqual(calls, [['launchctl', ['bootstrap', `gui/${process.getuid()}`, plist]]]);
  calls.length = 0;
  definition.ProgramArguments[1] = join(root, 'unrelated.mjs');
  await writeFile(plist, JSON.stringify(definition));
  await assert.rejects(controlService({ root, config, plist, action: 'start', run: (...args) => calls.push(args) }), /Service target does not match preflight/);
  assert.equal(calls.length, 0);
});
