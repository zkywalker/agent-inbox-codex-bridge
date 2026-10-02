import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Delivery } from '../shared/protocol.js';
import type { Session } from '../dist/src/state.js';
import { CodexRpc, RpcError } from '../dist/src/rpc.js';
import { BridgeState } from '../dist/src/state.js';
import { CodexBridge } from '../dist/src/bridge.js';
const fake = () => new CodexRpc(process.execPath, [resolve('tests/fixtures/codex-fake.mjs')]);

const missingThread = 'fixture-missing-thread';
async function recoveryFixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-recovery-'));
  const binary = join(dir, 'codex-fixture.mjs');
  const writeWrapper = (mode = '') => writeFile(binary, `#!${process.execPath}\nprocess.argv[2] = 'agent_inbox/0.144.6-test';\nprocess.argv[3] = ${JSON.stringify(mode)};\nawait import(${JSON.stringify(pathToFileURL(resolve('tests/fixtures/codex-fake.mjs')).href)});\n`, { mode: 0o755 });
  await writeWrapper();
  const state = new BridgeState(join(dir, 'state.sqlite'));
  const bridge = new CodexBridge({ gatewayUrl: 'http://127.0.0.1:1', token: 'recovery-fixture-only', managementToken: 'recovery-management-only', codexBinary: binary, stateDir: dir, projects: [{ id: 'fixture', name: 'Recovery fixture', path: dir }] }, fake(), state);
  const internals = bridge as any;
  const calls: { path: string; body: any }[] = [];
  const health: { component: string; code: string; revision: number }[] = [];
  bridge.onHealth = event => health.push({ ...event, revision: internals.connectionRevision });
  bridge.gateway.call = (async (path: string, body?: any) => {
    calls.push({ path, body: structuredClone(body) });
    if (path.startsWith('/connector/runtime/connections?')) return { revision: 7, connections: [] };
    assert.ok(['/connector/codex/connect', '/connector/codex/session', '/connector/runtime/report', '/connector/runtime/connections/ack'].includes(path) || /^\/connector\/deliveries\/[^/]+\/ack$/.test(path), `unexpected gateway call: ${path}`);
    return {};
  }) as typeof bridge.gateway.call;
  t.after(async () => {
    try { await bridge.stopAndWait(); }
    finally { state.close(); await rm(dir, { recursive: true, force: true }); }
  });
  await bridge.initialize();
  health.length = 0; calls.length = 0;
  const addSession = (threadId: string) => {
    const session: Session = { conversationId: randomUUID(), projectId: 'fixture', threadId, turnId: null, state: 'idle', model: null, provider: 'fake', error: null };
    bridge.sessions.set(session.conversationId, session); state.save(session);
    return session;
  };
  const delivery = (conversationId: string = randomUUID()): Delivery => {
    const now = new Date().toISOString();
    return { id: randomUUID(), conversation: { id: conversationId, agentId: 'fixture-agent', projectId: 'fixture', title: 'Recovery', archived: false, createdAt: now, updatedAt: now, lastMessage: null, unread: 0 }, message: { id: randomUUID(), conversationId, role: 'user', kind: 'chat', label: null, text: 'continue fixture conversation', attachments: [], status: 'sending', error: null, createdAt: now, updatedAt: now, seq: 1, streaming: false }, history: [] };
  };
  const ack = (input: Delivery) => calls.find(call => call.path === `/connector/deliveries/${input.id}/ack`)?.body;
  const prepareSync = () => {
    internals.connectionRevision = 6;
    state.saveManagedConnections([{ id: 'fixture-connection', name: 'Fixture', baseUrl: 'https://example.invalid/v1', apiMode: 'responses', models: [], apiKey: 'fixture-only', providerId: 'fixture-provider', envKey: `CODEX_TEST_${randomUUID().replaceAll('-', '')}` }]);
  };
  return { bridge, state, internals, calls, health, addSession, delivery, ack, prepareSync, writeWrapper };
}

for (const position of ['first', 'middle'] as const) test(`managed connection reload recovers healthy threads with a missing thread ${position}`, { skip: process.platform === 'win32', timeout: 10_000 }, async t => {
  const f = await recoveryFixture(t);
  const threadIds = position === 'first' ? [missingThread, 'fixture-healthy-a', 'fixture-healthy-b'] : ['fixture-healthy-a', missingThread, 'fixture-healthy-b'];
  const sessions = threadIds.map(f.addSession), bad = sessions.find(session => session.threadId === missingThread)!;
  const oldRpc = f.bridge.rpc;
  let oldClosed = false; oldRpc.child.once('close', () => { oldClosed = true; });
  f.prepareSync();
  await f.internals.syncManagedConnections();
  assert.notEqual(f.bridge.rpc, oldRpc);
  assert.equal(oldClosed, true, 'restart must await the old child close event');
  assert.equal(f.internals.runtimeReady, true);
  assert.equal(f.internals.registered, true);
  assert.equal(f.internals.stopped, false);
  assert.equal(f.internals.connectionRevision, 7);
  assert.ok(f.health.some(event => event.component === 'native' && event.code === 'healthy'));
  assert.ok(f.health.every(event => event.revision === 6), 'revision advances only after restart and registration succeed');
  assert.deepEqual(f.calls.filter(call => call.path === '/connector/runtime/connections/ack').map(call => call.body), [{ revision: 7, ok: true }]);
  assert.deepEqual(await f.bridge.rpc.request('test/recovery-counts'), { threadStarts: 0, resumes: threadIds, turnThreads: [], accountReads: 2 });
  for (const session of sessions) {
    assert.equal(session.state, session === bad ? 'failed' : 'idle');
    assert.equal(f.state.session(session.conversationId)?.threadId, session.threadId);
    assert.equal(f.state.session(session.conversationId)?.state, session.state);
    const published = f.calls.find(call => call.path === '/connector/codex/session' && call.body.session.conversationId === session.conversationId)?.body.session;
    assert.equal(published?.state, session.state);
    assert.equal(published?.threadId, session.threadId);
  }
  assert.equal(bad.threadId, missingThread);
  assert.ok(bad.error, 'missing thread must retain an actionable session error');
  const rejected = f.delivery(bad.conversationId);
  await f.bridge.accept(rejected);
  assert.equal(f.ack(rejected)?.ok, false);
  assert.equal(f.state.input(rejected.message.id), 'failed');
  assert.equal(bad.threadId, missingThread);
  const afterBad = await f.bridge.rpc.request('test/recovery-counts');
  assert.equal(afterBad.threadStarts, 0, 'failed resume must never create a replacement thread');
  assert.deepEqual(afterBad.turnThreads, [], 'bad topic must not execute a turn');
  for (const session of sessions.filter(session => session !== bad)) {
    const input = f.delivery(session.conversationId);
    await f.bridge.accept(input);
    assert.equal(f.ack(input)?.ok, true, 'healthy existing topics remain usable');
    assert.equal(f.state.input(input.message.id), 'accepted');
  }
  const fresh = f.delivery();
  await f.bridge.accept(fresh);
  assert.equal(f.ack(fresh)?.ok, true);
  assert.equal(f.state.input(fresh.message.id), 'accepted');
  const freshSession = f.bridge.sessions.get(fresh.conversation.id)!;
  assert.ok(freshSession.threadId);
  assert.notEqual(freshSession.threadId, missingThread);
  const final = await f.bridge.rpc.request('test/recovery-counts');
  assert.equal(final.threadStarts, 1, 'only the genuinely new topic creates a thread');
  assert.deepEqual(final.turnThreads, [...threadIds.filter(id => id !== missingThread), freshSession.threadId]);
});

for (const changed of [false, true]) test(`managed connection revision waits for a successful ACK (changed=${changed})`, { skip: process.platform === 'win32', timeout: 10_000 }, async t => {
  const f = await recoveryFixture(t);
  if (changed) f.prepareSync();
  else f.internals.connectionRevision = 6;
  const call = f.bridge.gateway.call.bind(f.bridge.gateway), revisionsAtAck: number[] = [];
  let failAck = true;
  f.bridge.gateway.call = (async (path: string, body?: any, ...args: any[]) => {
    if (path === '/connector/runtime/connections/ack' && body.ok) {
      revisionsAtAck.push(f.internals.connectionRevision);
      if (failAck) throw new Error('fixture ACK unavailable');
    }
    return call(path, body, ...args);
  }) as typeof f.bridge.gateway.call;
  await assert.rejects(f.internals.syncManagedConnections(), /fixture ACK unavailable/);
  assert.equal(f.internals.connectionRevision, 6, 'lost ACK must not consume the desired revision');
  assert.equal(f.internals.runtimeReady, true, 'ACK failure alone does not discard a verified runtime');
  assert.equal(f.internals.stopped, false);
  assert.equal(f.internals.connectionSync, null, 'failed synchronization must release its lock for confirmation retry');
  const verifiedRpc = f.bridge.rpc;
  failAck = false;
  await f.internals.syncManagedConnections();
  assert.equal(f.internals.connectionRevision, 7);
  assert.equal(f.bridge.rpc, verifiedRpc, 'confirmation retry must not restart the already applied configuration');
  assert.deepEqual(revisionsAtAck, [6, 6], 'both ACK attempts precede the revision commit');
  assert.deepEqual(f.calls.filter(call => call.path.startsWith('/connector/runtime/connections?')).map(call => call.path), ['/connector/runtime/connections?after=6', '/connector/runtime/connections?after=6']);
  assert.deepEqual(f.calls.filter(call => call.path === '/connector/runtime/connections/ack').map(call => call.body), [{ revision: 7, ok: false, error: 'failed' }, { revision: 7, ok: true }]);
});

test('stopping during old child close prevents a configuration restart from spawning a replacement', { skip: process.platform === 'win32', timeout: 10_000 }, async t => {
  const f = await recoveryFixture(t), oldRpc = f.bridge.rpc, closeAndWait = oldRpc.closeAndWait.bind(oldRpc);
  f.prepareSync();
  let stoppedDuringClose = false;
  t.mock.method(oldRpc, 'closeAndWait', async () => {
    assert.equal(f.internals.registered, false, 'configuration restart withdraws registration before closing the old child');
    assert.equal(f.internals.runtimeReady, false);
    const closing = closeAndWait();
    if (!stoppedDuringClose) { stoppedDuringClose = true; f.bridge.stop(); }
    await closing;
  });
  await assert.rejects(f.internals.syncManagedConnections(), /unavailable/);
  assert.equal(stoppedDuringClose, true);
  assert.equal(f.bridge.rpc, oldRpc, 'shutdown during close must not spawn a replacement child');
  assert.equal(f.internals.stopped, true);
  assert.equal(f.internals.runtimeReady, false);
  assert.equal(f.internals.registered, false);
  assert.equal(f.internals.connectionRevision, 6);
  assert.equal(f.internals.connectionSync, null);
  assert.ok(!f.health.some(event => event.code === 'healthy'));
  assert.ok(!f.calls.some(call => call.path === '/connector/codex/connect'));
  assert.deepEqual(f.calls.filter(call => call.path === '/connector/runtime/connections/ack').map(call => call.body), [{ revision: 7, ok: false, error: 'failed' }]);
});

test('native exit during registration cannot resurrect registered status or confirm a connection revision', { skip: process.platform === 'win32', timeout: 10_000 }, async t => {
  const f = await recoveryFixture(t), call = f.bridge.gateway.call.bind(f.bridge.gateway);
  f.prepareSync();
  let exited = false, healthAtExit = 0;
  f.bridge.gateway.call = (async (path: string, body?: any, ...args: any[]) => {
    const result = await call(path, body, ...args);
    if (path === '/connector/runtime/report' && body.conversationId === null) {
      exited = true;
      f.bridge.rpc.onExit(new RpcError('fixture exit during registration', undefined, true));
      healthAtExit = f.health.length;
    }
    return result;
  }) as typeof f.bridge.gateway.call;
  await assert.rejects(f.internals.syncManagedConnections(), /unavailable/);
  assert.equal(exited, true, 'exit must occur while the registration instance report is pending');
  assert.equal(f.internals.stopped, true);
  assert.equal(f.internals.runtimeReady, false);
  assert.equal(f.internals.registered, false);
  assert.equal(f.internals.registration, null);
  assert.equal(f.internals.connectionRevision, 6);
  assert.ok(!f.health.slice(healthAtExit).some(event => event.code === 'healthy'));
  assert.deepEqual(f.calls.filter(call => call.path === '/connector/runtime/connections/ack').map(call => call.body), [{ revision: 7, ok: false, error: 'failed' }]);
  const beforeRetry = f.calls.length;
  await assert.rejects(f.internals.register(), /unavailable/);
  assert.equal(f.calls.length, beforeRetry, 'registration entry must reject the stopped runtime before publishing');
});

for (const changed of [false, true]) test(`native exit before connection ACK returns cannot advance revision (changed=${changed})`, { skip: process.platform === 'win32', timeout: 10_000 }, async t => {
  const f = await recoveryFixture(t), call = f.bridge.gateway.call.bind(f.bridge.gateway);
  if (changed) f.prepareSync();
  else f.internals.connectionRevision = 6;
  let exited = false, healthAtExit = 0;
  f.bridge.gateway.call = (async (path: string, body?: any, ...args: any[]) => {
    const result = await call(path, body, ...args);
    if (path === '/connector/runtime/connections/ack' && body.ok) {
      assert.equal(f.internals.connectionRevision, 6);
      exited = true;
      f.bridge.rpc.onExit(new RpcError('fixture exit before ACK response', undefined, true));
      healthAtExit = f.health.length;
    }
    return result;
  }) as typeof f.bridge.gateway.call;
  await assert.rejects(f.internals.syncManagedConnections(), /unavailable/);
  assert.equal(exited, true);
  assert.equal(f.internals.connectionRevision, 6, 'an ACK response cannot prove a child that exited while waiting is healthy');
  assert.equal(f.internals.stopped, true);
  assert.equal(f.internals.runtimeReady, false);
  assert.equal(f.internals.registered, false);
  assert.equal(f.internals.connectionSync, null);
  assert.ok(!f.health.slice(healthAtExit).some(event => event.code === 'healthy'));
  assert.deepEqual(f.calls.filter(call => call.path === '/connector/runtime/connections/ack').map(call => call.body), [{ revision: 7, ok: true }, { revision: 7, ok: false, error: 'failed' }]);
  const input = f.delivery();
  await f.bridge.accept(input);
  assert.equal(f.ack(input)?.ok, false);
  assert.equal(f.bridge.sessions.has(input.conversation.id), false);
});

test('registration failure preserves a healthy replacement for registration and connection confirmation retry', { skip: process.platform === 'win32', timeout: 10_000 }, async t => {
  const f = await recoveryFixture(t), call = f.bridge.gateway.call.bind(f.bridge.gateway);
  f.prepareSync();
  const session = f.addSession('fixture-registration-retry-thread');
  let failReport = true;
  f.bridge.gateway.call = (async (path: string, body?: any, ...args: any[]) => {
    if (failReport && path === '/connector/runtime/report' && body.conversationId === null) throw new Error('fixture registration unavailable');
    return call(path, body, ...args);
  }) as typeof f.bridge.gateway.call;
  await assert.rejects(f.internals.syncManagedConnections(), /fixture registration unavailable/);
  const verifiedRpc = f.bridge.rpc;
  assert.equal(f.internals.runtimeReady, true);
  assert.equal(f.internals.stopped, false);
  assert.equal(f.internals.registered, false);
  assert.equal(f.internals.registration, null);
  assert.equal(f.internals.connectionSync, null);
  assert.equal(f.internals.connectionRevision, 6);
  assert.equal(session.state, 'idle');
  const counts = await verifiedRpc.request('test/recovery-counts');
  const blocked = f.delivery(session.conversationId);
  await f.bridge.accept(blocked);
  assert.equal(f.ack(blocked)?.ok, false, 'native readiness alone does not permit input before registration');
  failReport = false;
  await f.internals.register();
  await f.internals.syncManagedConnections();
  assert.equal(f.internals.registered, true);
  assert.equal(f.internals.connectionRevision, 7);
  assert.equal(f.bridge.rpc, verifiedRpc, 'registration retry reuses the verified replacement');
  assert.deepEqual(await verifiedRpc.request('test/recovery-counts'), counts, 'retry neither resumes threads again nor replays input');
  assert.deepEqual(f.calls.filter(call => call.path === '/connector/runtime/connections/ack').map(call => call.body), [{ revision: 7, ok: false, error: 'failed' }, { revision: 7, ok: true }]);
  const input = f.delivery(session.conversationId);
  await f.bridge.accept(input);
  assert.equal(f.ack(input)?.ok, true);
  assert.equal(f.state.input(input.message.id), 'accepted');
});

for (const strict of [false, true]) test(`uncertain resume aborts native recovery without healthy status (strict=${strict})`, { timeout: 10_000 }, async t => {
  const f = await recoveryFixture(t), uncertain = f.addSession('fixture-uncertain-thread'), healthy = f.addSession('fixture-healthy-after');
  const rpc = f.bridge.rpc, request = rpc.request.bind(rpc), failure = new RpcError('fixture resume outcome unknown', undefined, true);
  t.mock.method(rpc, 'request', async (method: string, params: any, timeout?: number) => {
    if (method === 'thread/resume' && params.threadId === uncertain.threadId) throw failure;
    return request(method, params, timeout);
  });
  await assert.rejects(f.internals.initializeNative(strict), (error: unknown) => strict ? error instanceof Error && error.message === 'update_reconnect_failed' : error === failure);
  assert.equal(uncertain.state, 'unknown');
  assert.equal(f.state.session(uncertain.conversationId)?.state, 'unknown');
  assert.equal(uncertain.threadId, 'fixture-uncertain-thread');
  assert.equal(f.internals.runtimeReady, false);
  assert.ok(!f.health.some(event => event.code === 'healthy'));
  const input = f.delivery(healthy.conversationId);
  await f.bridge.accept(input);
  assert.equal(f.ack(input)?.ok, false);
  const counts = await rpc.request('test/recovery-counts');
  assert.equal(counts.threadStarts, 0); assert.deepEqual(counts.turnThreads, []);
  assert.deepEqual(counts.resumes, [], 'global uncertainty aborts before later sessions resume');
});

test('strict native recovery still rejects a missing historical thread without replacing it', { timeout: 10_000 }, async t => {
  const f = await recoveryFixture(t), bad = f.addSession(missingThread);
  f.addSession('fixture-healthy-after');
  await assert.rejects(f.internals.initializeNative(true), /update_reconnect_failed/);
  assert.equal(bad.state, 'failed');
  assert.equal(f.state.session(bad.conversationId)?.threadId, missingThread);
  assert.equal(f.internals.runtimeReady, false);
  assert.ok(!f.health.some(event => event.code === 'healthy'));
  const counts = await f.bridge.rpc.request('test/recovery-counts');
  assert.equal(counts.threadStarts, 0); assert.deepEqual(counts.resumes, [missingThread]);
  assert.deepEqual(counts.turnThreads, []);
});

test('failed final account probe stops the configuration restart, closes its child and does not advance revision', { skip: process.platform === 'win32', timeout: 10_000 }, async t => {
  const f = await recoveryFixture(t);
  f.addSession('fixture-healthy-thread');
  f.prepareSync();
  await f.writeWrapper('fail-account-probe');
  const oldRpc = f.bridge.rpc;
  let replacement: CodexRpc | undefined, replacementClosed = false;
  const onHealth = f.bridge.onHealth!;
  f.bridge.onHealth = event => {
    onHealth(event);
    if (event.component === 'native' && event.code === 'starting' && f.bridge.rpc !== oldRpc) {
      replacement = f.bridge.rpc;
      replacement.child.once('close', () => { replacementClosed = true; });
    }
  };
  await assert.rejects(f.internals.syncManagedConnections(), /fixture final account probe failed/);
  assert.ok(replacement, 'the replacement child must have started');
  assert.equal(replacementClosed, true, 'restart rejection must await replacement close, not merely send a signal');
  assert.equal(f.internals.runtimeReady, false);
  assert.equal(f.internals.stopped, true);
  assert.equal(f.internals.registered, false);
  assert.equal(f.internals.transportAbort.signal.aborted, true);
  assert.equal(f.internals.connectionRevision, 6);
  assert.ok(!f.health.some(event => event.code === 'healthy'));
  assert.ok(!f.calls.some(call => call.path === '/connector/codex/connect'), 'failed initialization must not publish a new online instance');
  assert.deepEqual(f.calls.filter(call => call.path === '/connector/runtime/connections/ack').map(call => call.body), [{ revision: 7, ok: false, error: 'failed' }]);
  const input = f.delivery();
  await f.bridge.accept(input);
  assert.equal(f.ack(input)?.ok, false);
  assert.equal(f.bridge.sessions.has(input.conversation.id), false);
  await assert.rejects(replacement.request('test/recovery-counts'), (error: unknown) => error instanceof RpcError && error.uncertain);
});

test('configuration restart fails closed when the old child termination cannot be confirmed', { skip: process.platform === 'win32', timeout: 10_000 }, async t => {
  const f = await recoveryFixture(t), rpc = f.bridge.rpc, closeAndWait = rpc.closeAndWait.bind(rpc);
  f.prepareSync();
  let attempts = 0;
  t.mock.method(rpc, 'closeAndWait', async () => {
    if (++attempts === 1) throw new RpcError('fixture child termination unconfirmed', undefined, true);
    await closeAndWait();
  });
  await assert.rejects(f.internals.syncManagedConnections(), /fixture child termination unconfirmed/);
  assert.equal(f.bridge.rpc, rpc, 'unconfirmed old child must never be replaced by a second child');
  assert.equal(f.internals.runtimeReady, false);
  assert.equal(f.internals.stopped, true);
  assert.equal(f.internals.registered, false);
  assert.equal(f.internals.transportAbort.signal.aborted, true);
  assert.equal(f.internals.connectionRevision, 6);
  assert.ok(!f.health.some(event => event.code === 'healthy'));
  assert.deepEqual(f.calls.filter(call => call.path === '/connector/runtime/connections/ack').map(call => call.body), [{ revision: 7, ok: false, error: 'failed' }]);
});

for (const transition of ['stop', 'replace-rpc'] as const) test(`native recovery checks ${transition} after its bounded final account probe`, { timeout: 10_000 }, async t => {
  const f = await recoveryFixture(t), rpc = f.bridge.rpc, request = rpc.request.bind(rpc);
  let accountReads = 0, probeTimeout: number | undefined;
  t.mock.method(rpc, 'request', async (method: string, params: any, timeout?: number) => {
    const result = await request(method, params, timeout);
    if (method === 'account/read' && ++accountReads === 2) {
      probeTimeout = timeout;
      if (transition === 'stop') f.bridge.stop();
      else f.bridge.rpc = fake();
    }
    return result;
  });
  try {
    await assert.rejects(f.internals.initializeNative(), /unavailable/);
    assert.equal(accountReads, 2, 'readiness requires a fresh probe after recovery');
    assert.ok(typeof probeTimeout === 'number' && probeTimeout > 0 && probeTimeout <= 5000, 'final probe must have a bounded timeout');
    assert.equal(f.internals.runtimeReady, false);
    assert.ok(!f.health.some(event => event.code === 'healthy'));
  } finally { await rpc.closeAndWait(); }
});

for (const method of ['stop', 'stopAndWait'] as const) test(`${method} invalidates readiness even with detached native callbacks`, async t => {
  const fixture = await recoveryFixture(t);
  fixture.bridge.rpc.onExit = () => {};
  await fixture.bridge[method]();
  assert.equal(fixture.internals.runtimeReady, false);
  assert.equal(fixture.internals.registered, false);
  const input = fixture.delivery();
  await fixture.bridge.accept(input);
  assert.equal(fixture.ack(input)?.ok, false);
  assert.equal(fixture.bridge.sessions.has(input.conversation.id), false);
});

test('native health probe only reads account state, respects maintenance, and cannot revive a stopped runtime', async () => {
  const events: unknown[] = [], calls: unknown[] = [];
  let fail = false, pending: (() => void) | undefined;
  const host = {
    healthProbePending: false, stopped: false, runtimeReady: true, configurationChanging: false, updateTask: null, updateInfo: { status: 'idle' },
    rpc: { request: async (method: string, params: unknown, timeout: number) => { calls.push({ method, params, timeout }); if (fail) throw new Error('private native details'); if (pending) await new Promise<void>(resolve => { pending = resolve; }); } },
    onHealth: (event: unknown) => events.push(event),
  };
  const probe = () => CodexBridge.prototype.probeHealth.call(host as unknown as CodexBridge);
  await probe();
  assert.deepEqual(calls, [{ method: 'account/read', params: {}, timeout: 5000 }]);
  fail = true; await probe();
  assert.deepEqual(events.at(-1), { component: 'native', code: 'codex_unavailable' });
  host.configurationChanging = true; await probe(); assert.equal(calls.length, 2);
  host.configurationChanging = false; fail = false; pending = () => {};
  const waiting = probe(); await probe(); assert.equal(calls.length, 3);
  host.stopped = true; pending(); await waiting;
  assert.equal(events.length, 2);
});

for (const transition of ['configuration', 'not-ready', 'update-task', 'update-status', 'replacement'] as const) for (const failure of [false, true]) test(`in-flight native probe ignores ${failure ? 'failure' : 'success'} after ${transition}`, async () => {
  const events: unknown[] = [];
  let complete!: () => void;
  const host = {
    healthProbePending: false, stopped: false, runtimeReady: true, configurationChanging: false, updateTask: null as Promise<void> | null, updateInfo: { status: 'idle' },
    rpc: { request: async () => { await new Promise<void>(resolve => { complete = resolve; }); if (failure) throw new Error('fixture probe failed'); } },
    onHealth: (event: unknown) => events.push(event),
  };
  const pending = CodexBridge.prototype.probeHealth.call(host as unknown as CodexBridge);
  if (transition === 'configuration') host.configurationChanging = true;
  if (transition === 'not-ready') host.runtimeReady = false;
  if (transition === 'update-task') host.updateTask = Promise.resolve();
  if (transition === 'update-status') host.updateInfo.status = 'restarting';
  if (transition === 'replacement') host.rpc = { request: async () => {} };
  complete(); await pending;
  assert.deepEqual(events, []);
  assert.equal(host.healthProbePending, false);
});
