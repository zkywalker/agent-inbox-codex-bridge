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
