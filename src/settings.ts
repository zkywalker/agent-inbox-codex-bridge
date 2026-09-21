import { approvalPolicies, approvalsReviewers, sandboxModes, collaborationModes, personalities, reasoningSummaries, type CodexOptions, type CodexSettingsReport } from '../shared/codex-settings.js';
import type { CodexRpc } from './rpc.js';
import type { RuntimeEnvironment } from '../shared/runtime.js';

const modes: Record<string, CodexOptions['sandboxMode']> = { readOnly: 'read-only', workspaceWrite: 'workspace-write', dangerFullAccess: 'danger-full-access' };
export function settingsValues(native: any): CodexOptions {
  const values: CodexOptions = {};
  if (approvalPolicies.includes(native.approvalPolicy)) values.approvalPolicy = native.approvalPolicy;
  if (approvalsReviewers.includes(native.approvalsReviewer)) values.approvalsReviewer = native.approvalsReviewer;
  const sandbox = native.sandboxPolicy ?? native.sandbox;
  if (modes[sandbox?.type]) values.sandboxMode = modes[sandbox.type];
  if (typeof sandbox?.networkAccess === 'boolean') values.networkAccess = sandbox.networkAccess;
  if (sandbox?.type === 'dangerFullAccess') values.networkAccess = true;
  if (collaborationModes.includes(native.collaborationMode?.mode)) values.collaborationMode = native.collaborationMode.mode;
  if (personalities.includes(native.personality)) values.personality = native.personality;
  if (reasoningSummaries.includes(native.summary)) values.summary = native.summary;
  if (native.serviceTier === 'priority' || native.serviceTier === 'fast') values.serviceTier = 'fast';
  else if (native.serviceTier === null || native.serviceTier === 'default') values.serviceTier = 'default';
  return values;
}
export async function allowedSettings(rpc: CodexRpc): Promise<CodexSettingsReport['allowed']> {
  const [response, modes] = await Promise.all([rpc.request('configRequirements/read', {}), rpc.request('collaborationMode/list', {})]);
  if (!Object.hasOwn(response, 'requirements') || !Array.isArray(modes.data)) throw new Error('unavailable');
  const r = response.requirements;
  const filter = (values: readonly string[], allowed: unknown) => allowed == null ? [...values] : Array.isArray(allowed) ? values.filter(value => allowed.includes(value)) : [];
  return { approvalPolicies: filter(approvalPolicies, r?.allowedApprovalPolicies), approvalsReviewers: filter(approvalsReviewers, r?.allowedApprovalsReviewers), sandboxModes: filter(sandboxModes, r?.allowedSandboxModes), collaborationModes: collaborationModes.filter(mode => modes.data.some((item: any) => item.mode === mode)) };
}
// Preserve the native workspace roots and temporary-directory restrictions when
// changing network access. Raw policy stays on the bridge host, never in a write request from the browser.
export function settingsParams(values: CodexOptions, native: any, model: string | null, effort: string | null | undefined): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const key of ['approvalPolicy', 'approvalsReviewer', 'personality', 'summary'] as const) if (values[key] !== undefined) params[key] = values[key];
  if (values.serviceTier !== undefined) params.serviceTier = values.serviceTier === 'fast' ? 'fast' : null;
  if (values.collaborationMode !== undefined) {
    if (!model) throw new Error('unavailable');
    params.collaborationMode = { mode: values.collaborationMode, settings: { model, reasoning_effort: effort ?? null, developer_instructions: null } };
  }
  if (values.sandboxMode !== undefined || values.networkAccess !== undefined) {
    const previous = native?.sandboxPolicy ?? native?.sandbox;
    const mode = values.sandboxMode ?? modes[previous?.type];
    if (!mode || (mode === 'danger-full-access' && values.networkAccess === false)) throw new Error('unsupported');
    const networkAccess = values.networkAccess ?? (typeof previous?.networkAccess === 'boolean' ? previous.networkAccess : false);
    params.sandboxPolicy = mode === 'danger-full-access' ? { type: 'dangerFullAccess' } : mode === 'read-only' ? { type: 'readOnly', networkAccess } : {
      type: 'workspaceWrite', writableRoots: previous?.type === 'workspaceWrite' ? previous.writableRoots ?? [] : [],
      excludeSlashTmp: previous?.type === 'workspaceWrite' ? previous.excludeSlashTmp ?? false : false,
      excludeTmpdirEnvVar: previous?.type === 'workspaceWrite' ? previous.excludeTmpdirEnvVar ?? false : false, networkAccess,
    };
  }
  return params;
}
export function rememberedSettings(native: any, previous: Record<string, any> = {}) {
  const result = { ...previous };
  for (const key of ['approvalPolicy', 'approvalsReviewer', 'sandboxPolicy', 'activePermissionProfile', 'personality', 'summary', 'serviceTier']) if (Object.hasOwn(native, key)) result[key] = native[key];
  if (native.sandbox) result.sandboxPolicy = native.sandbox;
  if (native.collaborationMode) result.collaborationMode = { mode: native.collaborationMode.mode };
  return result;
}

// Older bridge state saved these native facts before editable settings existed.
// Carry them forward instead of reapplying today's host defaults on upgrade.
export function legacySettings(value: RuntimeEnvironment | undefined): Record<string, any> | undefined {
  if (!value || value.source !== 'runtime') return undefined;
  const native: Record<string, any> = {};
  if (approvalPolicies.includes(value.approvalPolicy as any)) native.approvalPolicy = value.approvalPolicy;
  if (approvalsReviewers.includes(value.approvalsReviewer as any)) native.approvalsReviewer = value.approvalsReviewer;
  if (value.sandbox === 'dangerFullAccess') native.sandboxPolicy = { type: 'dangerFullAccess' };
  else if (value.sandbox === 'readOnly' && value.networkAccess !== null) native.sandboxPolicy = { type: 'readOnly', networkAccess: value.networkAccess };
  else if (value.sandbox === 'workspaceWrite' && value.networkAccess !== null) native.sandboxPolicy = { type: 'workspaceWrite', networkAccess: value.networkAccess, writableRoots: value.writableRoots.filter(path => path !== value.cwd), excludeSlashTmp: false, excludeTmpdirEnvVar: false };
  return native;
}
