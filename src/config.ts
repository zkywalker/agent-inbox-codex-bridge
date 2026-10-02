import { z } from 'zod';
import { isAbsolute } from 'node:path';
import type { BridgeConfig } from './gateway.js';

const defaultCodexSettingsSchema = z.object({
  approvalPolicy: z.enum(['on-request', 'untrusted', 'never']).optional(),
  approvalsReviewer: z.enum(['user', 'auto_review']).optional(),
  sandboxMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  networkAccess: z.boolean().optional(),
}).strict().refine(value => value.sandboxMode !== 'danger-full-access' || value.networkAccess !== false, {
  message: 'danger-full-access cannot disable network access',
});

const projectSchema = z.object({
  id: z.string().min(1).max(256), name: z.string().min(1).max(120),
  path: z.string().refine(isAbsolute),
}).strict();

export const bridgeConfigSchema = z.object({
  configVersion: z.literal(1).optional(),
  gatewayUrl: z.string().url(), token: z.string().min(20), managementToken: z.string().min(20),
  accessClientId: z.string().optional(), accessClientSecret: z.string().optional(),
  codexBinary: z.string().min(1), stateDir: z.string().refine(isAbsolute),
  allowNativeUpdate: z.boolean().optional(), defaultCodexSettings: defaultCodexSettingsSchema.optional(),
  hostLabel: z.string().trim().min(1).max(120).optional(),
  projectRoots: z.array(projectSchema.extend({ id: z.string().min(1).max(120) })).max(20)
    .refine(roots => new Set(roots.map(root => root.id)).size === roots.length).optional(),
  projects: z.array(projectSchema).min(1).max(100)
    .refine(projects => new Set(projects.map(project => project.id)).size === projects.length),
  maxFileBytes: z.number().int().positive().max(25 * 1024 * 1024).optional(),
  maxRemoteFileBytes: z.number().int().positive().max(2 * 1024 * 1024 * 1024).optional(),
  additionalModels: z.array(z.object({
    model: z.string().trim().min(1).max(256),
    reasoningEfforts: z.array(z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])).max(8).optional(),
    defaultReasoningEffort: z.string().optional(),
  }).strict().refine(model => !model.defaultReasoningEffort || !!model.reasoningEfforts?.includes(model.defaultReasoningEffort as any)))
    .max(100).refine(models => new Set(models.map(model => model.model)).size === models.length).optional(),
}).strict().refine(value => (!!value.accessClientId === !!value.accessClientSecret), {
  message: 'accessClientId and accessClientSecret must be provided together', path: ['accessClientId'],
});

export const configContract = {
  kind: 'agent-inbox-codex-config', version: 1, acceptsLegacyUnversioned: true,
  migration: 'Validate all legacy fields before adding configVersion: 1; never discard unknown fields.',
  constraints: ['absolute project and state paths', 'unique project/model identities', 'paired Access credentials', 'danger-full-access requires network access'],
  schema: z.toJSONSchema(bridgeConfigSchema, { unrepresentable: 'any' }),
};

export function parseBridgeConfig(value: unknown): BridgeConfig {
  if (value && typeof value === 'object' && 'configVersion' in value && value.configVersion !== 1) throw new Error('config_invalid: unsupported configVersion; supported version is 1; use a compatible release or reviewed migration');
  return bridgeConfigSchema.parse(value) as BridgeConfig;
}

export function migrateBridgeConfig(value: unknown): BridgeConfig {
  return { ...parseBridgeConfig(value), configVersion: 1 };
}

export function describeStartupError(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map(issue => `${issue.path.map(part => typeof part === 'number' ? part : String(part).replace(/[^a-zA-Z0-9_]/g, '')).join('.') || '<root>'}: ${issue.code === 'unrecognized_keys' ? `Unrecognized keys (${issue.keys.slice(0, 8).map(key => /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(key) && !/token|secret|password/i.test(key) ? key : '<redacted-key>').join(', ')}); review against contract 1; no fields were discarded` : issue.code}`).join('; ');
  return error instanceof Error && (error.message.startsWith('config_invalid:') || ['instance_conflict', 'codex_unavailable'].includes(error.message)) ? error.message : 'Host operation failed; use --diagnose for safe status and recovery guidance';
}

export function startupExitCode(error: unknown) {
  if (error instanceof Error && error.message === 'instance_conflict') return 73;
  if (error instanceof Error && error.message === 'codex_unavailable') return 69;
  return error instanceof z.ZodError || error instanceof SyntaxError || error instanceof Error && error.message.startsWith('config_invalid:') ? 78 : 1;
}
