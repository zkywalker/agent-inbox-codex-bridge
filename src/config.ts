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

export function parseBridgeConfig(value: unknown): BridgeConfig { return bridgeConfigSchema.parse(value) as BridgeConfig; }

export function describeStartupError(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
  return error instanceof Error ? error.message : String(error);
}
