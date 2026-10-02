import { z } from 'zod';

export const imageToolDescription = 'Generate a new image with the owner-authorized Inbox image service. Check action=capabilities first. generate requires prompt (1–8000 characters) and a stable clientRequestId; get requires jobId. Poll get until succeeded, failed or uncertain. Generation returns an attachmentId and does not send a message. Send it separately with agent_inbox_send_attachment. Reuse the same clientRequestId after a lost response; never automatically create a new paid request after failed or uncertain results. Only new images are supported, not editing existing images. The gateway manages the provider and credentials; do not supply models, URLs, API keys or local file paths.';

export const imageToolProperties = {
  action: { type: 'string', enum: ['capabilities', 'generate', 'get'] },
  prompt: { type: 'string', minLength: 1, maxLength: 8000 },
  clientRequestId: { type: 'string', minLength: 1, maxLength: 128 },
  jobId: { type: 'string', format: 'uuid' },
};

export const imageToolSchema = z.object({
  action: z.enum(['capabilities', 'generate', 'get']),
  prompt: z.string().trim().min(1).max(8000).nullish(),
  clientRequestId: z.string().min(1).max(128).nullish(),
  jobId: z.string().uuid().nullish(),
}).strict();

export async function callImageTool(raw: unknown, call: (path: string, body?: unknown) => Promise<unknown>) {
  const parsed = imageToolSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid image tool arguments.');
  const args = parsed.data;
  if (args.action === 'capabilities') return call('/connector/image-generation');
  if (args.action === 'get') {
    if (!args.jobId) throw new Error('Supply jobId for get.');
    return call(`/connector/image-generation/jobs/${args.jobId}`);
  }
  if (!args.prompt || !args.clientRequestId) throw new Error('Supply prompt and a stable clientRequestId.');
  return call('/connector/image-generation/jobs', { prompt: args.prompt, clientRequestId: args.clientRequestId });
}
