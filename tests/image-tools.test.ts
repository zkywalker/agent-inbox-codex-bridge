import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeState, type Session } from '../dist/src/state.js';
import { CodexBridge } from '../dist/src/bridge.js';
import type { CodexRpc } from '../dist/src/rpc.js';
import { GatewayError } from '../dist/src/gateway.js';
import { callImageTool } from '../dist/shared/image-tool.js';

async function fixture(t: test.TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'image-tools-')));
  const state = new BridgeState(join(dir, 'state.sqlite'));
  t.after(async () => { state.close(); await rm(dir, { recursive: true, force: true }); });
  const requests: { method: string; params: any }[] = [];
  let response: any;
  const rpc = {
    request: async (method: string, params: any) => {
      requests.push({ method, params });
      assert(['thread/start', 'thread/resume'].includes(method));
      return { thread: { id: params.threadId ?? 'new-native-thread', turns: [] }, cwd: dir, model: 'fixture', modelProvider: 'fixture', sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false } };
    },
    respond: (_id: unknown, result: unknown) => { response = result; },
    close() {},
  } as unknown as CodexRpc;
  const bridge = new CodexBridge({ gatewayUrl: 'http://localhost', token: 'image-tool-test-only', managementToken: '', codexBinary: 'unused', stateDir: dir, projects: [{ id: 'fixture', name: 'Fixture', path: dir }] }, rpc, state);
  const session: Session = { conversationId: randomUUID(), projectId: 'fixture', threadId: 'bound-native-thread', turnId: null, model: null, provider: 'fixture', state: 'idle', error: null };
  const invoke = async (args: object, callId = randomUUID(), name = 'agent_inbox_generate_image') => {
    await (bridge as any).dynamic(session, 'rpc-call', { tool: name, callId, arguments: args });
    return response;
  };
  return { bridge, state, session, requests, invoke };
}

test('Codex registers the image tool for new threads and preserves existing thread identity on resume', async t => {
  const { bridge, session, requests } = await fixture(t);
  const fresh = { ...session, conversationId: randomUUID(), threadId: null };
  await (bridge as any).ensureThread(fresh);
  const start = requests[0];
  assert.equal(start.method, 'thread/start');
  const tools = start.params.dynamicTools;
  const image = tools.find((tool: any) => tool.name === 'agent_inbox_generate_image');
  assert(image, 'model must receive image tool, not only a callable handler');
  assert.deepEqual(image.inputSchema.required, ['action']);
  assert.equal(image.inputSchema.additionalProperties, false);
  assert.deepEqual(image.inputSchema.properties.action.enum, ['capabilities', 'generate', 'get']);
  assert.equal(image.inputSchema.properties.prompt.maxLength, 8000);
  assert(tools.some((tool: any) => tool.name === 'agent_inbox_send_attachment'));
  const threadId = session.threadId;
  await (bridge as any).ensureThread(session);
  assert.equal(requests[1].method, 'thread/resume');
  assert.equal(requests[1].params.threadId, threadId);
  assert.equal('dynamicTools' in requests[1].params, false, 'native resume does not accept dynamic tools');
  assert.equal(session.threadId, threadId);
  assert.equal(requests.length, 2, 'must not replace an existing thread to add tools');
});

test('Codex image generation queries and submits scoped jobs, deduplicates calls and sends only explicitly', async t => {
  const { bridge, session, invoke } = await fixture(t);
  const calls: { path: string; body?: unknown }[] = [];
  const jobId = randomUUID(), attachmentId = randomUUID();
  bridge.gateway.call = (async (path: string, body?: unknown) => {
    calls.push({ path, body });
    if (path.endsWith('/messages')) return { id: 'sent-image' };
    if (path.endsWith('/jobs')) return { id: jobId, status: 'running' };
    if (path.endsWith(jobId)) return { id: jobId, status: 'succeeded', attachmentId };
    return { enabled: true, allowed: true, generatesOnly: true };
  }) as typeof bridge.gateway.call;
  const parse = (response: any) => { assert.equal(response.success, true, JSON.stringify(response)); return JSON.parse(response.contentItems[0].text); };
  assert.equal(parse(await invoke({ action: 'capabilities' })).allowed, true);
  assert.deepEqual(calls.at(-1), { path: '/connector/image-generation', body: undefined });
  const generate = { action: 'generate', prompt: '一张中文雾灵山亲子导游图', clientRequestId: 'stable-image-request' };
  const callId = randomUUID();
  const first = await invoke(generate, callId);
  assert.equal(parse(first).id, jobId);
  assert.deepEqual(calls.at(-1), { path: '/connector/image-generation/jobs', body: { prompt: generate.prompt, clientRequestId: generate.clientRequestId } });
  assert.deepEqual(await invoke(generate, callId), first);
  assert.equal(calls.length, 2, 'replayed native tool calls cannot submit twice');
  assert.equal(parse(await invoke({ action: 'get', jobId })).attachmentId, attachmentId);
  assert.deepEqual(calls.at(-1), { path: `/connector/image-generation/jobs/${jobId}`, body: undefined });
  assert(!calls.some(call => call.path.endsWith('/messages')), 'generating and polling must not send');
  parse(await invoke({ attachmentId, clientMessageId: 'stable-image-message' }, randomUUID(), 'agent_inbox_send_attachment'));
  assert.deepEqual(calls.at(-1), { path: `/connector/conversations/${session.conversationId}/messages`, body: { text: '', attachmentIds: [attachmentId], clientMessageId: 'stable-image-message' } });
});

test('image tool rejects missing fields, malformed job IDs, excessive prompts and provider overrides before network access', async () => {
  let calls = 0;
  const call = async () => { calls++; };
  for (const input of [
    { action: 'generate', prompt: 'cat' },
    { action: 'generate', clientRequestId: 'missing-prompt' },
    { action: 'generate', prompt: '   ', clientRequestId: 'blank-prompt' },
    { action: 'generate', prompt: 'x'.repeat(8001), clientRequestId: 'oversized' },
    { action: 'get' }, { action: 'get', jobId: '../settings' },
    ...['model', 'baseUrl', 'apiKey', 'connectionId', 'path'].map(key => ({ action: 'generate', prompt: 'cat', clientRequestId: 'override', [key]: 'private-fixture-value' })),
  ]) await assert.rejects(callImageTool(input, call), error => error instanceof Error && !error.message.includes('private-fixture-value'));
  assert.equal(calls, 0);
});

test('image tool keeps authorization failures and uncertain jobs terminal without retries or messages', async t => {
  const { bridge, invoke } = await fixture(t);
  let calls = 0;
  bridge.gateway.call = (async () => { calls++; throw new GatewayError(403, 'image_generation_disabled'); }) as typeof bridge.gateway.call;
  const callId = randomUUID();
  const generate = { action: 'generate', prompt: 'cat', clientRequestId: 'permission-rejected' };
  const rejected = await invoke(generate, callId);
  assert.equal(rejected.success, false);
  assert.match(rejected.contentItems[0].text, /image_generation_disabled/);
  assert.deepEqual(await invoke(generate, callId), rejected);
  assert.equal(calls, 1);
  for (const status of ['failed', 'uncertain'] as const) {
    calls = 0;
    bridge.gateway.call = (async () => { calls++; return { id: randomUUID(), status, attachmentId: null }; }) as typeof bridge.gateway.call;
    const response = await invoke({ action: 'get', jobId: randomUUID() });
    assert.equal(JSON.parse(response.contentItems[0].text).status, status);
    assert.equal(calls, 1);
  }
});
