import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CodexBridge } from '../dist/src/bridge.js';
import { BridgeState, type Session } from '../dist/src/state.js';
import { GatewayError } from '../dist/src/gateway.js';
import type { CodexRpc } from '../dist/src/rpc.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t: test.TestContext) {
  const state = new BridgeState(':memory:');
  const rpc = { close() {}, async closeAndWait() {} } as unknown as CodexRpc;
  const bridge = new CodexBridge({ gatewayUrl: 'http://localhost', token: 'test-channel', managementToken: 'test-management', codexBinary: process.execPath, stateDir: '', projects: [{ id: 'fixture', name: 'Fixture', path: process.cwd() }] }, rpc, state);
  const internals = bridge as any;
  internals.registered = true;
  internals.runtimeReady = true;
  let running: Promise<void> | undefined;
  t.after(async () => { bridge.stop(); await running; state.close(); });
  return { bridge, state, internals, start: () => { running = internals.controlLoop(); return running!; } };
}
function registrationFixture(t: test.TestContext) {
  const f = fixture(t);
  const sessions = ['before', 'rejected', 'after'].map(name => {
    const session: Session = { conversationId: randomUUID(), projectId: 'fixture', threadId: `native-${name}`, turnId: null, model: null, provider: 'native', state: 'idle', error: null };
    f.bridge.sessions.set(session.conversationId, session); f.internals.changed(session);
    return session;
  });
  for (const status of ['accepted', 'failed', 'uncertain']) f.state.markInput(status, status);
  const mappings = f.state.sessions();
  const calls: { path: string; body: any }[] = [];
  f.bridge.gateway.call = (async (path: string, body?: any) => { calls.push({ path, body }); return {}; }) as typeof f.bridge.gateway.call;
  return { ...f, sessions, calls, assertPreserved: () => {
    assert.deepEqual(f.state.sessions(), mappings);
    assert.deepEqual([...f.bridge.sessions.values()], mappings);
    for (const status of ['accepted', 'failed', 'uncertain']) assert.equal(f.state.input(status), status);
    assert.ok(!calls.some(call => call.path.includes('/ack') || call.path.includes('/inbox')));
  } };
}

for (const failure of [new GatewayError(404, 'not_found'), new GatewayError(409, 'conflict')]) {
  for (const position of [0, 1]) test(`registration isolates historical ${failure.status}/${failure.code} at position ${position}`, async t => {
    const f = registrationFixture(t), rejected = f.sessions[position];
    const call = f.bridge.gateway.call;
    f.bridge.gateway.call = (async (path: string, body?: any) => {
      await call(path, body);
      if (path === '/connector/codex/session' && body.session.conversationId === rejected.conversationId) throw failure;
      return {};
    }) as typeof f.bridge.gateway.call;
    const epochs = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      f.internals.registered = false;
      await f.internals.register();
      epochs.push(f.internals.epoch);
      assert.equal(f.internals.registered, true);
      assert.ok(f.internals.dirtySessions.has(rejected.conversationId));
      assert.ok(f.internals.sessionRetryAt.get(rejected.conversationId) > Date.now());
      for (const session of f.sessions.filter(session => session !== rejected)) assert.ok(!f.internals.dirtySessions.has(session.conversationId));
    }
    assert.notEqual(epochs[0], epochs[1]);
    assert.equal(f.calls.filter(call => call.path === '/connector/codex/session').length, 6);
    assert.equal(f.calls.filter(call => call.path === '/connector/runtime/report' && call.body.conversationId === null).length, 2);
    f.assertPreserved();
  });
}

test('registration isolates a deleted topic between its session and runtime reports', async t => {
  const f = registrationFixture(t), rejected = f.sessions[1], call = f.bridge.gateway.call;
  f.bridge.gateway.call = (async (path: string, body?: any) => {
    await call(path, body);
    if (path === '/connector/runtime/report' && body.conversationId === rejected.conversationId) throw new GatewayError(404, 'not_found');
    return {};
  }) as typeof f.bridge.gateway.call;
  await f.internals.register();
  assert.equal(f.internals.registered, true);
  assert.ok(f.internals.dirtySessions.has(rejected.conversationId));
  assert.ok(f.calls.some(call => call.path === '/connector/runtime/report' && call.body.conversationId === f.sessions[2].conversationId));
  f.assertPreserved();
});

for (const failure of [
  new GatewayError(401, 'unauthorized'), new GatewayError(403, 'forbidden'),
  new GatewayError(409, 'reconnect'), new GatewayError(409, 'unavailable'),
  new GatewayError(404, 'request_failed'), new GatewayError(400, 'validation_error'),
  new GatewayError(429, 'rate_limited'), new GatewayError(503, 'gateway_unreachable'),
  new TypeError('fetch failed'), new SyntaxError('invalid response'),
]) for (const endpoint of ['/connector/codex/session', '/connector/runtime/report']) {
  test(`registration propagates ${endpoint} ${failure.message}`, async t => {
    const f = registrationFixture(t), call = f.bridge.gateway.call;
    f.bridge.gateway.call = (async (path: string, body?: any) => {
      await call(path, body);
      if (path === endpoint) throw failure;
      return {};
    }) as typeof f.bridge.gateway.call;
    await assert.rejects(f.internals.register(), (error: unknown) => error === failure);
    assert.equal(f.internals.registered, false);
    assert.equal(f.internals.registration, null);
    assert.ok(!f.calls.some(call => call.path === '/connector/codex/session' && call.body.session.conversationId === f.sessions[1].conversationId));
    f.assertPreserved();
  });
}

for (const endpoint of ['/connector/codex/connect', '/connector/runtime/report']) {
  test(`registration never isolates instance-level errors from ${endpoint}`, async t => {
    const f = registrationFixture(t), call = f.bridge.gateway.call;
    const failure = new GatewayError(404, 'not_found');
    f.bridge.gateway.call = (async (path: string, body?: any) => {
      await call(path, body);
      if (path === endpoint && (endpoint !== '/connector/runtime/report' || body.conversationId === null)) throw failure;
      return {};
    }) as typeof f.bridge.gateway.call;
    await assert.rejects(f.internals.register(), (error: unknown) => error === failure);
    assert.equal(f.internals.registered, false);
    f.assertPreserved();
  });
}

async function untilAborted(signal?: AbortSignal) {
  if (signal?.aborted) return;
  await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }));
}

test('Codex control, approvals and heartbeat continue while a historical session report stalls', { timeout: 8000 }, async t => {
  const f = fixture(t), held = deferred(), reportStarted = deferred(), controlled = deferred(), approved = deferred();
  f.internals.transportAbort.signal.addEventListener('abort', held.resolve, { once: true });
  const counts = { session: 0, heartbeat: 0, configuration: 0, controls: 0 };
  for (let i = 0; i < 100; i++) {
    const session: Session = { conversationId: randomUUID(), projectId: 'fixture', threadId: `native-${i}`, turnId: null, model: null, provider: 'native', state: 'idle', error: null };
    f.bridge.sessions.set(session.conversationId, session); f.state.save(session);
  }
  f.internals.changed(f.bridge.sessions.values().next().value);
  f.internals.control = async () => { controlled.resolve(); };
  f.internals.publishApprovals = async () => { await reportStarted.promise; approved.resolve(); };
  f.bridge.gateway.call = (async (path: string, body?: any, _management?: boolean, _method?: string, signal?: AbortSignal) => {
    if (path === '/connector/codex/session') { counts.session++; reportStarted.resolve(); await held.promise; return {}; }
    if (path === '/connector/runtime/report') { if (!body.conversationId) counts.heartbeat++; return {}; }
    if (path.startsWith('/connector/runtime/connections')) { counts.configuration++; return { revision: 0, connections: null }; }
    if (path.startsWith('/connector/codex/inbox?')) {
      assert.match(path, /wait=20/); counts.controls++;
      if (counts.controls === 1) { await reportStarted.promise; return { actions: [{ id: randomUUID() }] }; }
      await untilAborted(signal); return { actions: [] };
    }
    if (path.startsWith('/connector/runtime/inbox?')) {
      assert.match(path, /wait=20/); assert.match(path, /instanceId=/);
      await untilAborted(signal); return { requests: [] };
    }
    return {};
  }) as typeof f.bridge.gateway.call;
  const loop = f.start();
  await Promise.all([controlled.promise, approved.promise]);
  held.resolve(); await pause(1150);
  assert.equal(counts.session, 1, 'unchanged history is never re-uploaded each tick');
  assert.equal(counts.heartbeat, 1, 'instance heartbeat is independent and at most once per ten seconds');
  assert.equal(counts.configuration, 1);
  const stoppedAt = performance.now(); f.bridge.stop(); await loop;
  assert.ok(performance.now() - stoppedAt < 500, 'shutdown aborts both held management polls');
});

test('Codex compatibility with an immediate old inbox is rate bounded', { timeout: 8000 }, async t => {
  const f = fixture(t); let controls = 0, runtime = 0;
  f.internals.lastInstanceReportAt = Date.now();
  f.bridge.gateway.call = (async (path: string) => {
    if (path.startsWith('/connector/runtime/connections')) return { revision: 0, connections: null };
    if (path.startsWith('/connector/codex/inbox?')) { controls++; return { actions: [] }; }
    if (path.startsWith('/connector/runtime/inbox?')) { runtime++; return { requests: [] }; }
    return {};
  }) as typeof f.bridge.gateway.call;
  f.start(); await pause(1250);
  assert.ok(controls >= 1 && controls <= 2);
  assert.ok(runtime >= 1 && runtime <= 2);
});

test('one rejected Codex session cannot starve other dirty reports and auth failures pause management', { timeout: 8000 }, async t => {
  const f = fixture(t); let reports = 0, polls = 0;
  const rejected = randomUUID(), healthy = randomUUID();
  for (const conversationId of [rejected, healthy]) {
    const session: Session = { conversationId, projectId: 'fixture', threadId: conversationId, turnId: null, model: null, provider: 'native', state: 'idle', error: null };
    f.bridge.sessions.set(conversationId, session); f.internals.changed(session);
  }
  f.bridge.gateway.call = (async (path: string, body?: any, _m?: boolean, _method?: string, signal?: AbortSignal) => {
    if (path === '/connector/codex/session') { reports++; if (body.session.conversationId === rejected) throw new GatewayError(400, 'validation_error'); return {}; }
    if (path.startsWith('/connector/runtime/connections')) return { revision: 0, connections: null };
    if (path.startsWith('/connector/codex/inbox?')) { polls++; await pause(50); throw new GatewayError(403, 'forbidden'); }
    if (path.startsWith('/connector/runtime/inbox?')) { await untilAborted(signal); return { requests: [] }; }
    return {};
  }) as typeof f.bridge.gateway.call;
  f.start(); await pause(1250);
  assert.equal(reports, 2); assert.equal(polls, 1);
  assert.ok(f.internals.dirtySessions.has(rejected)); assert.ok(!f.internals.dirtySessions.has(healthy));
  assert.ok(f.internals.managementRetryAt > Date.now() + 50_000);
});
