import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireHostLocks, HostHealth, diagnoseHost } from '../dist/src/host-safety.js';
import { configContract, migrateBridgeConfig, parseBridgeConfig } from '../dist/src/config.js';
import { RestartPolicy, preflight } from '../supervisor/host-preflight.mjs';

async function fixture(context) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bridge-host-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'state')); await mkdir(join(root, 'other'));
  const config = { gatewayUrl: 'https://inbox.example', token: 'fixture-message-token-only', managementToken: 'fixture-management-token-only', codexBinary: process.execPath, stateDir: join(root, 'state'), projects: [{ id: 'project', name: 'Project', path: root }] };
  return { root, config };
}

test('credential and state locks reject collisions and release only owned records', async context => {
  const { root, config } = await fixture(context), locks = join(root, 'locks');
  const owner = await acquireHostLocks(config, locks);
  await assert.rejects(acquireHostLocks({ ...config, stateDir: join(root, 'other') }, locks), /instance_conflict/);
  await assert.rejects(acquireHostLocks({ ...config, token: 'other-token-for-same-state' }, locks), /instance_conflict/);
  assert.equal((await readdir(locks)).length, 2);
  await owner.release(); assert.deepEqual(await readdir(locks), []);
});

test('release contract matches validator and migration never drops unknown fields', async context => {
  const { config } = await fixture(context);
  assert.deepEqual(JSON.parse(await readFile(new URL('../config-contract.json', import.meta.url))), configContract);
  assert.deepEqual(migrateBridgeConfig(config), { ...config, configVersion: 1 });
  assert.throws(() => migrateBridgeConfig({ ...config, unknown: 'private-fixture' }));
  assert.throws(() => parseBridgeConfig({ ...config, configVersion: 2 }));
});

test('diagnostic output keeps credential faults separate from successful message polls', async context => {
  const { root } = await fixture(context), directory = join(root, 'health'), file = join(root, 'config.json');
  const health = new HostHealth(file, directory);
  await health.start();
  health.observe({ component: 'native', code: 'healthy' });
  health.observe({ component: 'gateway', code: 'auth_failed', scope: 'management' });
  health.observe({ component: 'gateway', code: 'healthy', scope: 'message' });
  await health.flush(); assert.equal((await diagnoseHost(file, directory)).code, 'auth_failed');
  await health.finish('codex_unavailable', 1, true);
  assert.equal((await diagnoseHost(file, directory)).startupFailures, 1);
});

test('CLI validation and migration neither run Codex nor overwrite the original', async context => {
  const { root, config } = await fixture(context), file = join(root, 'config.json'), output = join(root, 'migrated.json');
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const cli = new URL('../dist/src/main.js', import.meta.url);
  await promisify(execFile)(process.execPath, [cli.pathname, '--validate', file]);
  assert.deepEqual(await readdir(config.stateDir), []);
  await promisify(execFile)(process.execPath, [cli.pathname, '--migrate-config', file, output]);
  assert.deepEqual(JSON.parse(await readFile(file)), config);
  assert.equal(JSON.parse(await readFile(output)).configVersion, 1);
  await assert.rejects(promisify(execFile)(process.execPath, [cli.pathname, '--migrate-config', file, output]));
});

test('retry budget is bounded and preflight refuses bad bundles', async context => {
  const { root } = await fixture(context), policy = new RestartPolicy();
  assert.deepEqual(Array.from({ length: 5 }, () => policy.next()), [5000, 10000, 20000, 40000, null]);
  await assert.rejects(preflight(root, join(root, 'missing.json')), /config_invalid/);
});
