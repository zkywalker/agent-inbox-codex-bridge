import type { RuntimeEnvironment, RuntimeReport } from '../shared/runtime.js';
import type { CodexRpc } from './rpc.js';
import { stableKey } from './state.js';

export type Inventory = Pick<RuntimeReport, 'skills' | 'mcp' | 'providers' | 'inventory'>;
export const text = (value: unknown, max = 256) => typeof value === 'string' ? value.slice(0, max) : '';
export function environment(native: any, host: string, project: string | null, source: RuntimeEnvironment['source']): RuntimeEnvironment {
  const policy = native.sandboxPolicy ?? native.sandbox;
  return { host, project, cwd: text(native.cwd, 2048), source,
    sandbox: text(policy?.type) || null,
    writableRoots: [...new Set<string>([...(policy?.type === 'workspaceWrite' && native.cwd ? [native.cwd] : []), ...(Array.isArray(policy?.writableRoots) ? policy.writableRoots : [])])].map(path => text(path, 2048)).slice(0, 100),
    networkAccess: typeof policy?.networkAccess === 'boolean' ? policy.networkAccess : policy?.type === 'dangerFullAccess' || policy?.networkAccess === 'enabled' ? true : policy?.networkAccess === 'restricted' ? false : null,
    approvalPolicy: typeof native.approvalPolicy === 'string' ? text(native.approvalPolicy) : native.approvalPolicy?.granular ? 'granular' : null,
    approvalsReviewer: text(native.approvalsReviewer) || null };
}
function endpoint(value: unknown) {
  try { const url = new URL(text(value, 2048)); if (!['http:', 'https:'].includes(url.protocol)) return null; return url.origin + url.pathname; } catch { return null; }
}
export async function inspect(rpc: CodexRpc, cwd: string, threadId: string | null, statuses: Map<string, string>): Promise<Inventory & { config: any; targets: Map<string, { kind: 'skill' | 'mcp'; value: string }>; userLayer: any }> {
  const warnings: string[] = [];
  let config: any = null, skills: RuntimeReport['skills'] = null, mcp: RuntimeReport['mcp'] = null;
  const targets = new Map<string, { kind: 'skill' | 'mcp'; value: string }>();
  const results = await Promise.allSettled([
    rpc.request('config/read', { cwd, includeLayers: true }),
    rpc.request('skills/list', { cwds: [cwd], forceReload: true }),
    (async () => {
      const servers: any[] = []; let cursor: string | undefined; const cursors = new Set<string>();
      do {
        const page = await rpc.request('mcpServerStatus/list', { ...(threadId ? { threadId } : {}), detail: 'toolsAndAuthOnly', limit: 100, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(page.data)) throw new Error('invalid inventory');
        servers.push(...page.data); cursor = page.nextCursor ?? undefined;
        if (cursor && cursors.has(cursor)) throw new Error('repeated cursor');
        if (cursor) cursors.add(cursor);
      } while (cursor && servers.length < 100);
      if (cursor) warnings.push('MCP 清单已截断。');
      return servers.slice(0, 100);
    })(),
  ]);
  const [configuration, skillResult, mcpResult] = results;
  const userLayer = configuration.status === 'fulfilled' ? configuration.value.layers?.find((layer: any) => layer.name?.type === 'user' && !layer.disabledReason) : null;
  if (configuration.status === 'fulfilled' && configuration.value.config) config = configuration.value.config;
  else warnings.push('提供商配置暂时无法读取。');
  if (skillResult.status === 'fulfilled') {
    const entry = skillResult.value.data?.find((entry: any) => entry.cwd === cwd);
    if (Array.isArray(entry?.skills)) {
      skills = entry.skills.slice(0, 500).map((skill: any) => {
        const id = stableKey(`skill:${skill.path}`), mutable = typeof skill.path === 'string' && ['repo', 'user'].includes(skill.scope);
        if (mutable) targets.set(id, { kind: 'skill', value: skill.path });
        return { id, mutable, name: text(skill.name), description: text(skill.description, 1000), scope: skill.enabled ? 'available' : 'installed', enabled: !!skill.enabled, source: text(skill.scope) };
      });
      if (entry.errors?.length || entry.skills.length > 500) warnings.push('部分技能无法读取或清单已截断。');
    } else warnings.push('技能清单暂时无法读取。');
  } else warnings.push('技能清单暂时无法读取。');
  if (mcpResult.status === 'fulfilled') {
    const names = new Set([...Object.keys(config?.mcp_servers ?? {}), ...mcpResult.value.map(server => server.name)]);
    mcp = [...names].slice(0, 100).map(name => {
      const server = mcpResult.value.find(server => server.name === name);
      const startup = statuses.get(`${threadId ?? ''}:${name}`);
      const status = startup === 'failed' ? 'failed' : startup === 'cancelled' ? 'disconnected' : startup === 'starting' ? 'connecting' : startup === 'ready' || server?.serverInfo || Object.keys(server?.tools ?? {}).length > 0 ? 'connected' : config?.mcp_servers?.[name]?.enabled === false ? 'disabled' : 'configured';
      const id = stableKey(`mcp:${name}`), mutable = /^[A-Za-z0-9_-]+$/.test(name) && !!config?.mcp_servers?.[name] && !!userLayer?.name?.file && !!userLayer?.version;
      if (mutable) targets.set(id, { kind: 'mcp', value: name });
      return { id, mutable, enabled: config?.mcp_servers?.[name]?.enabled !== false, name: text(name), status, tools: Object.keys(server?.tools ?? {}).map(tool => text(tool)).slice(0, 300), authStatus: text(server?.authStatus) };
    });
  } else warnings.push('MCP 状态暂时无法读取。');
  // Only explicitly selected display fields cross the management connection.
  // Never return config layers, headers, environment variables or credentials.
  const providerId = config?.model_provider ?? 'openai';
  const providers = config ? [...new Set([providerId, ...Object.keys(config.model_providers ?? {})])].slice(0, 100).map(id => {
    const provider = config.model_providers?.[id];
    return { id: text(id), name: text(provider?.name || id), apiMode: text(provider?.wire_api || 'responses'), endpoint: endpoint(provider?.base_url), current: id === providerId };
  }) : null;
  return { config, targets, userLayer, skills, mcp, providers, inventory: { scope: threadId ? 'project' : 'instance', observedAt: new Date().toISOString(), warnings } };
}
