import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexBridge } from '../dist/src/bridge.js';
import { BridgeManagementUpdate } from '../dist/src/bridge-management-update.js';
import { BridgeState } from '../dist/src/state.js';
import { CodexRpc } from '../dist/src/rpc.js';
import { GatewayError } from '../dist/src/gateway.js';
import { hostBridgePlatform } from '../dist/src/bridge-host-update.js';
import { BRIDGE_MANIFEST_SIGNATURE_DOMAIN, BRIDGE_PLATFORMS, BRIDGE_RELEASE_REPOSITORY } from '../dist/shared/bridge-release.js';

function signedRequest() {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const keyId = createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, repository: BRIDGE_RELEASE_REPOSITORY, version: '0.1.4', publishedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), assets: BRIDGE_PLATFORMS.map(platform => ({ platform, name: `codex-bridge-0.1.4-${platform}.tar.gz`, size: 1, sha256: '1'.repeat(64) })) }));
  const signature = Buffer.from(JSON.stringify({ schemaVersion: 1, algorithm: 'ed25519', keyId, signature: sign(null, Buffer.concat([Buffer.from(`${BRIDGE_MANIFEST_SIGNATURE_DOMAIN}${keyId}\n`), manifest]), keys.privateKey).toString('base64') }));
  const at = new Date().toISOString();
  const request = { id: randomUUID(), agentId: randomUUID(), conversationId: null, kind: 'update-bridge', payload: { targetVersion: '0.1.4' }, status: 'running', error: null, result: null, createdAt: at, updatedAt: at, bridgeRelease: { snapshot: { manifest: manifest.toString('base64'), signature: signature.toString('base64') }, manifestSha256: createHash('sha256').update(manifest).digest('hex'), platform: hostBridgePlatform(), fromVersion: '0.1.3', fromInstanceId: randomUUID() } };
  return { request, publicKey };
}

function recordFor(request, status, acknowledged, outcome = status) {
  const terminal = ['succeeded', 'failed', 'uncertain'].includes(status);
  return { request, acknowledged, confirmation: terminal ? { operationId: request.id, instanceId: request.bridgeRelease.fromInstanceId, manifestSha256: request.bridgeRelease.manifestSha256, outcome } : null, info: { supported: true, currentVersion: status === 'succeeded' ? '0.1.4' : '0.1.3', targetVersion: '0.1.4', operationId: request.id, status, error: status === 'failed' ? 'update_bridge_failed' : status === 'uncertain' ? 'update_bridge_interrupted' : null, updatedAt: request.updatedAt } };
}

async function fixture(t, record, { realRpc = false, publicKey } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-report-'));
  const statePath = join(directory, 'state.sqlite');
  const state = new BridgeState(statePath);
  if (record) state.saveBridgeUpdate(record);
  const config = { gatewayUrl: 'http://127.0.0.1:1', token: 'unused-test-channel', managementToken: 'unused-test-management', codexBinary: process.execPath, stateDir: directory, projects: [{ id: 'project', name: 'Project', path: directory }] };
  const calls = { prepares: [], notifications: [] };
  const driver = { keys: publicKey ? [publicKey] : [], prepare: async (request, _signal, retryProof) => { calls.prepares.push({ request, retryProof }); return { manifestSha256: request.bridgeRelease.manifestSha256 }; }, notify: async message => { calls.notifications.push(message); } };
  const rpc = realRpc ? new CodexRpc(process.execPath, [fileURLToPath(new URL('../tests/fixtures/codex-fake.mjs', import.meta.url)), 'agent_inbox/0.154.0']) : { close() {}, async closeAndWait() {} };
  const bridge = new CodexBridge(config, rpc, state, undefined, driver);
  bridge.bridgeVersion = '0.1.4';
  t.after(async () => { await bridge.stopAndWait(); state.close(); await rm(directory, { recursive: true, force: true }); });
  const body = () => state.db.prepare('SELECT body FROM bridge_update WHERE id=1').get()?.body;
  return { bridge, state, statePath, driver, calls, body };
}

test('ordinary instance reports omit only acknowledged settled updates and preserve the SQLite ledger', async t => {
  const { request } = signedRequest();
  for (const status of ['succeeded', 'failed', 'uncertain', 'staging', 'restarting', 'verifying']) {
    for (const acknowledged of [false, true]) await t.test(`${status}, acknowledged=${acknowledged}`, async child => {
      const record = recordFor(request, status, acknowledged);
      const sample = await fixture(child, record), before = sample.body();
      const report = JSON.parse(JSON.stringify(sample.bridge.report(null)));
      const omitted = acknowledged && ['succeeded', 'failed'].includes(status);
      assert.equal(Object.hasOwn(report, 'bridgeUpdate'), !omitted);
      if (!omitted) assert.deepEqual(report.bridgeUpdate, record.info);
      assert.equal(report.bridgeVersion, '0.1.4');
      assert.equal(report.bridgeUpdateCapability.safeRetry, true);
      assert.deepEqual(sample.bridge.bridgeUpdate.info, record.info);
      assert.equal(sample.body(), before, 'reporting must not rewrite the durable ledger');
      const topic = sample.bridge.report({ conversationId: randomUUID(), projectId: 'project', state: 'idle' });
      assert.equal(Object.hasOwn(topic, 'bridgeUpdate'), false);
      assert.equal(Object.hasOwn(topic, 'bridgeVersion'), false);
    });
  }
  await t.test('no maintenance history', async child => {
    const sample = await fixture(child);
    assert.equal(Object.hasOwn(sample.bridge.report(null), 'bridgeUpdate'), false);
    assert.equal(sample.state.bridgeUpdate(), undefined);
  });
});

test('acknowledged history survives reopening and never resends an update confirmation', async t => {
  const { request } = signedRequest();
  for (const outcome of ['succeeded', 'failed', 'rolled-back']) await t.test(outcome, async child => {
    const record = recordFor(request, outcome === 'succeeded' ? 'succeeded' : 'failed', true, outcome);
    const sample = await fixture(child, record), before = sample.body();
    const reopened = new BridgeState(sample.statePath);
    try {
      const updater = new BridgeManagementUpdate(reopened, sample.driver);
      updater.resume(null, '0.1.5', randomUUID());
      await updater.publish(async () => assert.fail('acknowledged history must not be sent again'));
      assert.equal(updater.reportInfo, undefined);
      assert.deepEqual(updater.info, record.info);
      assert.deepEqual(reopened.bridgeUpdate(), record);
      assert.equal(sample.body(), before);
      assert.equal(sample.calls.prepares.length, 0);
    } finally { reopened.close(); }
  });
});

test('lost result responses retain the proof and ordinary report until the exact confirmation succeeds', async t => {
  const { request } = signedRequest();
  for (const outcome of ['succeeded', 'failed', 'rolled-back']) await t.test(outcome, async child => {
    const record = recordFor(request, outcome === 'succeeded' ? 'succeeded' : 'failed', false, outcome);
    const sample = await fixture(child, record), updater = sample.bridge.bridgeUpdate, before = sample.body();
    let posts = 0;
    await assert.rejects(updater.publish(async proof => { posts++; assert.deepEqual(proof, record.confirmation); assert.deepEqual(sample.bridge.report(null).bridgeUpdate, record.info); throw new Error('lost acknowledgement'); }), /lost acknowledgement/);
    assert.equal(updater.busy, true);
    assert.equal(sample.body(), before);
    assert.deepEqual(sample.bridge.report(null).bridgeUpdate, record.info);
    await updater.publish(async proof => { posts++; assert.deepEqual(proof, record.confirmation); assert.deepEqual(sample.bridge.report(null).bridgeUpdate, record.info); });
    assert.equal(posts, 2);
    assert.equal(updater.busy, false);
    assert.equal(Object.hasOwn(sample.bridge.report(null), 'bridgeUpdate'), false);
    assert.deepEqual(sample.state.bridgeUpdate(), { ...record, acknowledged: true });
    await updater.publish(async () => assert.fail('successful acknowledgement must not be repeated'));
  });
});

test('uncertain results remain visible and locked even after successful result delivery', async t => {
  const { request } = signedRequest(), record = recordFor(request, 'uncertain', false);
  const sample = await fixture(t, record), before = sample.body();
  for (let attempt = 0; attempt < 2; attempt++) await sample.bridge.bridgeUpdate.publish(async proof => assert.deepEqual(proof, record.confirmation));
  assert.equal(sample.bridge.bridgeUpdate.busy, true);
  assert.deepEqual(sample.bridge.report(null).bridgeUpdate, record.info);
  assert.equal(sample.body(), before);
  const next = { ...request, id: randomUUID() };
  await assert.rejects(sample.bridge.bridgeUpdate.start(next, '0.1.3', request.bridgeRelease.fromInstanceId, () => true), /busy/);
  assert.equal(sample.calls.prepares.length, 0);
});

test('hidden acknowledged rollback still supplies the original proof only to a valid same-instance retry', async t => {
  const { request, publicKey } = signedRequest();
  for (const sameInstance of [true, false]) await t.test(`same instance=${sameInstance}`, async child => {
    const record = recordFor(request, 'failed', true, 'rolled-back');
    const sample = await fixture(child, record, { publicKey });
    assert.equal(Object.hasOwn(sample.bridge.report(null), 'bridgeUpdate'), false);
    const instanceId = sameInstance ? request.bridgeRelease.fromInstanceId : randomUUID();
    const next = { ...request, id: randomUUID(), bridgeRelease: { ...request.bridgeRelease, fromInstanceId: instanceId } };
    await sample.bridge.bridgeUpdate.start(next, '0.1.3', instanceId, () => true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sample.calls.prepares.length, 1);
    assert.deepEqual(sample.calls.prepares[0].retryProof, sameInstance ? { operationId: request.id, manifestSha256: request.bridgeRelease.manifestSha256, fromVersion: '0.1.3', targetVersion: '0.1.4' } : undefined);
    assert.equal(sample.bridge.report(null).bridgeUpdate.operationId, next.id);
    assert.equal(sample.state.bridgeUpdate().acknowledged, false);
  });
});

test('settled report omission does not bypass identity or signature checks for another update', async t => {
  const { request, publicKey } = signedRequest(), record = recordFor(request, 'succeeded', true);
  const sample = await fixture(t, record, { publicKey }), before = sample.body();
  const next = { ...request, id: randomUUID() }, instanceId = request.bridgeRelease.fromInstanceId;
  await assert.rejects(sample.bridge.bridgeUpdate.start(next, '0.1.3', randomUUID(), () => true), /update_bridge_manifest_invalid/);
  const signature = JSON.parse(Buffer.from(next.bridgeRelease.snapshot.signature, 'base64').toString());
  signature.signature = Buffer.alloc(64).toString('base64');
  const tampered = { ...next, bridgeRelease: { ...next.bridgeRelease, snapshot: { ...next.bridgeRelease.snapshot, signature: Buffer.from(JSON.stringify(signature)).toString('base64') } } };
  await assert.rejects(sample.bridge.bridgeUpdate.start(tampered, '0.1.3', instanceId, () => true));
  assert.equal(sample.calls.prepares.length, 0);
  assert.equal(sample.body(), before);
});

test('simulated registration tolerates absent acknowledged history but rejects an unknown unconfirmed operation', async t => {
  const { request } = signedRequest();
  for (const acknowledged of [true, false]) await t.test(`acknowledged=${acknowledged}`, async child => {
    const record = recordFor(request, 'succeeded', acknowledged);
    const sample = await fixture(child, record, { realRpc: true }), before = sample.body();
    let reports = 0;
    // Local contract stub deliberately has no admitted operations. No gateway or provider is contacted.
    sample.bridge.gateway.call = async (path, body) => {
      if (path === '/connector/codex/connect') return {};
      assert.equal(path, '/connector/runtime/report');
      reports++;
      if (body.bridgeUpdate?.operationId) throw new GatewayError(400, 'invalid', 'unknown admitted operation');
      return undefined;
    };
    if (acknowledged) { await sample.bridge.initialize(); assert.ok(sample.bridge.supervisorIdentity()); }
    else { await assert.rejects(sample.bridge.initialize(), error => error instanceof GatewayError && error.status === 400); assert.equal(sample.bridge.supervisorIdentity(), null); }
    assert.equal(reports, 1);
    assert.equal(sample.body(), before);
    assert.equal(sample.calls.prepares.length, 0);
  });
});
