import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeCodexUpdate, readCodexInstalledVersion, runCodexUpdate } from '../dist/src/update.js';

type FakeChild = ChildProcess & { stdout: PassThrough; stderr: PassThrough };
const missingGroup = () => { throw Object.assign(new Error('private host detail'), { code: 'ESRCH' }); };
function simulate(t: TestContext, handler: (child: FakeChild, args: string[]) => void, kill: (pid: number, signal: NodeJS.Signals) => boolean = missingGroup) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  const calls: { binary: string; args: string[]; options: unknown }[] = [];
  const killCalls: { pid: number; signal: NodeJS.Signals }[] = [];
  t.mock.method(childProcess, 'spawn', (binary: string, args: string[], options: unknown) => {
    calls.push({ binary, args, options });
    const child = Object.assign(new EventEmitter(), { pid: 123456789, stdout: new PassThrough(), stderr: new PassThrough() }) as FakeChild;
    queueMicrotask(() => handler(child, args));
    return child;
  });
  t.mock.method(process, 'kill', (pid: number, signal: NodeJS.Signals) => { killCalls.push({ pid, signal }); return kill(pid, signal); });
  return { calls, killCalls };
}
function close(child: FakeChild, code = 0) { child.stdout.end(); child.stderr.end(); child.emit('exit', code, null); child.emit('close', code, null); }

test('a host-selected registry is scoped to the fixed native update child', async t => {
  const { calls } = simulate(t, child => close(child));
  const previous = { ...process.env };
  const registry = 'https://npm-mirror.example/registry/';
  assert.deepEqual(await runCodexUpdate('codex', { registry }), { ok: true, code: 'completed' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['update']);
  const options = calls[0].options as childProcess.SpawnOptions;
  assert.equal(options.shell, false);
  assert.equal(options.env?.npm_config_registry, registry);
  assert.equal(options.env?.NPM_CONFIG_REGISTRY, registry);
  assert.ok(Object.keys(previous).every(key => ['npm_config_registry', 'NPM_CONFIG_REGISTRY'].includes(key) || options.env?.[key] === previous[key]));
  assert.ok(Object.keys(previous).length === Object.keys(process.env).length && Object.keys(previous).every(key => process.env[key] === previous[key]));
  await probeCodexUpdate('codex', { registry });
  await readCodexInstalledVersion('codex', { registry });
  assert.equal((calls[1].options as childProcess.SpawnOptions).env, undefined);
  assert.equal((calls[2].options as childProcess.SpawnOptions).env, undefined);
});

test('unsafe mirror settings never spawn an installer or trigger a fallback', async t => {
  const { calls } = simulate(t, () => assert.fail('must not spawn'));
  for (const registry of ['', 'http://mirror.example/', 'file:///tmp/package', 'https://user:secret@mirror.example/', 'https://mirror.example/?token=secret', 'https://mirror.example/#fragment', 'https://mirror.example/\n', 'https:\\mirror.example']) {
    assert.deepEqual(await runCodexUpdate('codex', { registry }), { ok: false, code: 'invalid-registry' });
  }
  assert.equal(calls.length, 0);
});

test('an update failure using a mirror never retries against another registry', async t => {
  const { calls } = simulate(t, child => close(child, 1));
  assert.deepEqual(await runCodexUpdate('codex', { registry: 'https://npm-mirror.example/' }), { ok: false, code: 'exit-failed' });
  assert.equal(calls.length, 1);
});

test('native update probing only invokes fixed help and version with closed stdin and no shell', async t => {
  const { calls } = simulate(t, (child, args) => {
    child.stdout.write(args[0] === '--version' ? 'codex-cli 0.154.0-alpha.1+build.7\n' : 'Update Codex\nUsage: codex update [OPTIONS]\n');
    close(child);
  });
  assert.deepEqual(await probeCodexUpdate('/fixed path/codex'), { available: true, reason: 'supported' });
  assert.equal(await readCodexInstalledVersion('/fixed path/codex'), '0.154.0-alpha.1+build.7');
  assert.deepEqual(calls.map(c => [c.binary, c.args]), [['/fixed path/codex', ['update', '--help']], ['/fixed path/codex', ['--version']]]);
  for (const call of calls) assert.deepEqual(call.options, { cwd: undefined, shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
});

test('all fixed commands resolve a relative binary in the same locally configured directory as App Server', async t => {
  const { calls } = simulate(t, (child, args) => {
    if (args[0] === '--version') child.stdout.write('codex-cli 0.154.0\n');
    else if (args.includes('--help')) child.stdout.write('Usage: codex update [OPTIONS]\n');
    close(child);
  });
  const options = { cwd: '/private/local project' };
  assert.deepEqual(await probeCodexUpdate('./bin/codex', options), { available: true, reason: 'supported' });
  assert.equal(await readCodexInstalledVersion('./bin/codex', options), '0.154.0');
  assert.deepEqual(await runCodexUpdate('./bin/codex', options), { ok: true, code: 'completed' });
  assert.deepEqual(calls.map(call => [call.binary, call.args]), [['./bin/codex', ['update', '--help']], ['./bin/codex', ['--version']], ['./bin/codex', ['update']]]);
  for (const call of calls) assert.deepEqual(call.options, { cwd: options.cwd, shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
});

test('old CLI root help and failed help never advertise update support', async t => {
  let next = 0;
  simulate(t, child => { child.stdout.write(next++ === 0 ? 'Usage: codex [OPTIONS] [PROMPT]\nupdate your code' : 'Usage: codex update [OPTIONS]\n'); close(child, next === 1 ? 0 : 1); });
  assert.deepEqual(await probeCodexUpdate('codex'), { available: false, reason: 'unavailable' });
  assert.deepEqual(await probeCodexUpdate('codex'), { available: false, reason: 'unavailable' });
});

test('installed version accepts only a version line and never reveals arbitrary native output', async t => {
  let next = 0;
  const samples = ['codex-cli 0.154.0\n/private/SECRET\n', 'codex-cli 00.154.0', 'codex-cli 0.154.0?token=SECRET', 'node v22.13.0'];
  simulate(t, child => { child.stdout.write(samples[next++]); close(child); });
  for (const _ of samples) assert.equal(await readCodexInstalledVersion('codex'), null);
});

test('update executes only the fixed update command and reports exit status without private output', async t => {
  let next = 0;
  const { calls } = simulate(t, child => { child.stdout.write('PRIVATE FILE /home/person'); child.stderr.write('SECRET TOKEN'); close(child, next++); });
  assert.deepEqual(await runCodexUpdate('/fixed/codex'), { ok: true, code: 'completed' });
  assert.deepEqual(await runCodexUpdate('/fixed/codex'), { ok: false, code: 'exit-failed' });
  assert.deepEqual(calls.map(c => c.args), [['update'], ['update']]);
});

test('missing executable returns a stable spawn failure', async t => {
  simulate(t, child => { Object.defineProperty(child, 'pid', { value: undefined }); child.emit('error', new Error('ENOENT /private/codex')); });
  assert.deepEqual(await runCodexUpdate('/private/codex'), { ok: false, code: 'spawn-failed' });
});

test('bounded stdout plus stderr prevents retaining or returning unlimited diagnostics', async t => {
  simulate(t, child => { child.stdout.write('x'.repeat(32 * 1024)); child.stderr.write('S'.repeat(32 * 1024 + 1)); queueMicrotask(() => close(child)); });
  assert.deepEqual(await runCodexUpdate('codex'), { ok: false, code: 'output-limit' });
});

test('timeout sends one group kill before wrapper exit and never signals the released group again', async t => {
  let child: FakeChild;
  const { killCalls } = simulate(t, spawned => { child = spawned; }, () => { close(child); return true; });
  assert.deepEqual(await runCodexUpdate('codex', { timeoutMs: 10 }), { ok: false, code: 'timeout' });
  assert.deepEqual(killCalls, [{ pid: -123456789, signal: 'SIGKILL' }]);
});

test('a wrapper that exits before its streams close cannot authorize signalling a possibly reused PGID', async t => {
  const { killCalls } = simulate(t, child => child.emit('exit', 0, null), () => assert.fail('old group must not be signalled'));
  assert.deepEqual(await runCodexUpdate('codex', { timeoutMs: 10 }), { ok: false, code: 'cleanup-failed' });
  assert.deepEqual(killCalls, []);
});

test('a successful kill submission without a confirmed wrapper close remains uncertain', async t => {
  simulate(t, () => {}, () => true);
  assert.deepEqual(await runCodexUpdate('codex', { timeoutMs: 10 }), { ok: false, code: 'cleanup-failed' });
});

test('abort waits for group cleanup and does not retry update', async t => {
  const controller = new AbortController();
  let child: FakeChild;
  const { calls, killCalls } = simulate(t, spawned => { child = spawned; controller.abort(); }, (_pid, signal) => { if (signal === 'SIGKILL') queueMicrotask(() => close(child)); return true; });
  assert.deepEqual(await runCodexUpdate('codex', { signal: controller.signal }), { ok: false, code: 'cancelled' });
  assert.equal(calls.length, 1);
  assert.deepEqual(killCalls.map(c => c.signal), ['SIGKILL']);
});

test('failure to terminate installer is distinct from ordinary update failure', async t => {
  simulate(t, () => {}, () => { throw Object.assign(new Error('private process detail'), { code: 'EPERM' }); });
  assert.deepEqual(await runCodexUpdate('codex', { timeoutMs: 10 }), { ok: false, code: 'cleanup-failed' });
});

test('normal completion never signals a group ID released by the exited wrapper', async t => {
  const { killCalls } = simulate(t, child => close(child), () => assert.fail('released group must not be signalled'));
  assert.deepEqual(await runCodexUpdate('codex'), { ok: true, code: 'completed' });
  assert.deepEqual(killCalls, []);
});

test('pre-cancelled commands and Windows capability do not spawn an installer', async t => {
  const { calls } = simulate(t, () => assert.fail('must not spawn'));
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await runCodexUpdate('codex', { signal: controller.signal }), { ok: false, code: 'cancelled' });
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  assert.deepEqual(await probeCodexUpdate('codex'), { available: false, reason: 'unsupported-platform' });
  assert.deepEqual(await runCodexUpdate('codex'), { ok: false, code: 'unsupported-platform' });
  assert.equal(await readCodexInstalledVersion('codex'), null);
  assert.equal(calls.length, 0);
});

// Real POSIX subprocess coverage uses a disposable fake installation, never Codex.
test('POSIX fake binary verifies arguments and kills a real installer descendant', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'inbox-codex-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'codex');
  await copyFile(fileURLToPath(new URL('./fixtures/codex-update-fake.mjs', import.meta.url)), binary);
  await chmod(binary, 0o700);
  assert.deepEqual(await probeCodexUpdate(binary), { available: true, reason: 'supported' });
  assert.equal(await readCodexInstalledVersion(binary), '0.154.0');
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'calls.json'), 'utf8')), [['update', '--help'], ['--version']]);
  await writeFile(path.join(directory, 'mode'), 'registry');
  const registry = 'https://npm-mirror.example/registry/';
  assert.deepEqual(await runCodexUpdate(binary, { registry }), { ok: true, code: 'completed' });
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'registry.json'), 'utf8')), { lower: registry, upper: registry });
  await writeFile(path.join(directory, 'mode'), 'descendant');
  const result = await runCodexUpdate(binary, { timeoutMs: 800 });
  assert.deepEqual(result, { ok: false, code: 'timeout' });
  const heartbeat = path.join(directory, 'heartbeat');
  const after = await readFile(heartbeat, 'utf8');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await readFile(heartbeat, 'utf8'), after, 'descendant must stop modifying the fake installation');
});
