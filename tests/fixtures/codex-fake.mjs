import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let starts = 0;
let threadStarts = 0, accountReads = 0;
const resumes = [], turnThreads = [];
let settings = {}, notifySettings = true;
const threads = new Map(), skillEnabled = new Map();
const mcpConfig = { pending: {}, broken: {} };
let requirements = null, configVersion = 1;
let chain = Promise.resolve();
createInterface({ input: process.stdin }).on('line', line => { chain = chain.then(() => handle(line)); });
async function handle(line) {
  const m = JSON.parse(line), p = m.params ?? {};
  const reply = result => send({ id: m.id, result });
  if (m.method === 'initialize') reply({ userAgent: process.argv[2] ?? 'agent_inbox/0.144.6-test (TestOS 1.0.0; x86_64) test_terminal/2.0.0' });
  else if (m.method === 'account/read') {
    accountReads++;
    if (process.argv[3] === 'fail-account-probe' && accountReads > 1) send({ id: m.id, error: { code: -1, message: 'fixture final account probe failed' } });
    else reply({ account: { type: 'apiKey' } });
  }
  else if (m.method === 'model/list') reply({ data: [{ model: 'fake-model', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Light' }, { reasoningEffort: 'high', description: 'Deep' }] }, { model: 'other-model', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }], defaultReasoningEffort: 'medium' }] });
  else if (m.method === 'configRequirements/read') reply({ requirements });
  else if (m.method === 'test/requirements') { requirements = p.value; reply({}); }
  else if (m.method === 'collaborationMode/list') reply({ data: [{ mode: 'default' }, { mode: 'plan' }] });
  else if (m.method === 'config/read') reply({ layers: [{ name: { type: 'user', file: '/private/DO-NOT-EXPOSE/config.toml' }, version: String(configVersion) }], config: { model: 'fake-model', model_reasoning_effort: 'high', model_provider: 'fake', model_providers: { fake: { name: 'Test connection', base_url: 'https://user:DO-NOT-EXPOSE@example.test/v1?secret=DO-NOT-EXPOSE', env_key: 'DO-NOT-EXPOSE', http_headers: { authorization: 'DO-NOT-EXPOSE' } } }, mcp_servers: mcpConfig } });
  else if (m.method === 'skills/list') reply({ data: [{ cwd: p.cwds[0], skills: [{ path: '/private/DO-NOT-EXPOSE/project/SKILL.md', name: 'project-skill', description: 'Read current project', enabled: skillEnabled.get('/private/DO-NOT-EXPOSE/project/SKILL.md') ?? true, scope: 'repo' }, { path: '/private/DO-NOT-EXPOSE/user/SKILL.md', name: 'disabled-skill', description: 'Disabled', enabled: skillEnabled.get('/private/DO-NOT-EXPOSE/user/SKILL.md') ?? false, scope: 'user' }], errors: [] }] });
  else if (m.method === 'skills/config/write') { skillEnabled.set(p.path, p.enabled); reply({ effectiveEnabled: p.enabled }); }
  else if (m.method === 'config/value/write') {
    if (p.expectedVersion !== String(configVersion)) send({ id: m.id, error: { code: -1, message: 'version conflict' } });
    else {
      if (!p.keyPath.startsWith('model_providers.')) mcpConfig[p.keyPath.split('.')[1]].enabled = p.value;
      configVersion++; reply({});
    }
  }
  else if (m.method === 'mcpServerStatus/list') { send({ method: 'mcpServer/startupStatus/updated', params: { threadId: p.threadId ?? null, name: 'broken', status: 'failed' } }); reply({ data: [{ name: 'pending', tools: {}, authStatus: 'unsupported' }, { name: 'broken', tools: {}, authStatus: 'notLoggedIn' }] }); }
  else if (m.method === 'thread/settings/update') {
    const prior = threads.get(p.threadId);
    settings = { ...threads.get(p.threadId), ...p, ...(p.serviceTier === 'fast' ? { serviceTier: 'priority' } : p.serviceTier === null ? { serviceTier: 'default' } : {}) };
    threads.set(p.threadId, settings); const confirmed = settings;
    const changed = Object.keys(p).some(key => key !== 'threadId' && JSON.stringify(prior?.[key]) !== JSON.stringify(settings[key]));
    reply({}); if (notifySettings && changed) setTimeout(() => send({ method: 'thread/settings/updated', params: { threadId: p.threadId, threadSettings: confirmed } }), 70);
  }
  else if (m.method === 'test/notifications') { notifySettings = p.enabled; reply({}); }
  else if (m.method === 'thread/start' || m.method === 'thread/resume') {
    if (m.method === 'thread/resume') {
      resumes.push(p.threadId);
      if (p.threadId === 'fixture-missing-thread') { send({ id: m.id, error: { code: -32000, message: 'no rollout found for thread fixture-missing-thread' } }); return; }
    }
    settings = { cwd: p.cwd, model: p.model ?? 'fake-model', modelProvider: 'fake', effort: p.config?.model_reasoning_effort ?? 'high', approvalPolicy: p.approvalPolicy ?? 'on-request', approvalsReviewer: p.approvalsReviewer ?? 'user', sandboxPolicy: { type: p.sandbox === 'read-only' ? 'readOnly' : p.sandbox === 'danger-full-access' ? 'dangerFullAccess' : 'workspaceWrite', writableRoots: [], networkAccess: p.sandbox === 'danger-full-access' }, collaborationMode: { mode: 'default' }, personality: 'none', summary: 'auto', serviceTier: null };
    const threadId = p.threadId ?? (++threadStarts === 1 ? 'native-fake-thread' : `native-fake-thread-${threadStarts}`);
    threads.set(threadId, settings);
    reply({ ...settings, reasoningEffort: settings.effort, sandbox: settings.sandboxPolicy, thread: { id: threadId, turns: [] } });
  }
  else if (m.method === 'turn/start') {
    starts++; turnThreads.push(p.threadId);
    const turn = { id: `fake-turn-${starts}`, status: 'inProgress' };
    send({ method: 'turn/started', params: { threadId: p.threadId, turn } });
    await new Promise(r => setTimeout(r, 180));
    reply({ turn });
    send({ method: 'item/started', params: { threadId: p.threadId, turnId: turn.id, item: { id: 'answer', type: 'agentMessage', text: '' } } });
    const output = Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: p.threadId, itemId: 'answer', delta: `中文 response ${starts}` } }) + '\n');
    const split = output.indexOf(Buffer.from('中文')) + 1;
    process.stdout.write(output.subarray(0, split));
    await new Promise(r => setTimeout(r, 10));
    process.stdout.write(output.subarray(split));
    send({ method: 'item/completed', params: { threadId: p.threadId, turnId: turn.id, item: { id: 'answer', type: 'agentMessage', text: `中文 response ${starts}` } } });
    send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { ...turn, status: 'completed' } } });
  } else if (m.method === 'test/starts') reply({ starts });
  else if (m.method === 'test/recovery-counts') reply({ threadStarts, resumes, turnThreads, accountReads });
  else if (m.method === 'test/close') process.exit(0);
  else if (m.method === 'test/timeout') { /* leave unresolved */ }
  else if (m.id != null && m.method) reply({});
}
