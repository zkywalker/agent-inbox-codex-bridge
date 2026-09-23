import { z } from 'zod';
import type { RuntimeRequest, BridgeUpdateInfo } from '../shared/runtime.js';
import type { BridgeUpdateConfirmation } from '../shared/bridge-update.js';
import type { BridgeState } from './state.js';
import { BRIDGE_PLATFORMS } from '../shared/bridge-release.js';
import { hostBridgePlatform, verifyBridgeSnapshot, prepareBridgeRelease, type BridgeRetryProof } from './bridge-host-update.js';

const planSchema = z.object({ snapshot: z.object({ manifest: z.string().max(24 * 1024), signature: z.string().max(4096) }).strict(), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/), platform: z.enum(BRIDGE_PLATFORMS), fromVersion: z.string().max(64), fromInstanceId: z.string().uuid() }).strict();

export interface BridgeManagementDriver {
  keys: readonly string[];
  prepare: (request: RuntimeRequest, signal: AbortSignal, retryProof?: BridgeRetryProof) => Promise<{ manifestSha256: string }>;
  notify: (message: { type: 'bridge-update-ready'; operationId: string; version: string } | { type: 'bridge-update-status' }) => Promise<void>;
}
export interface BridgeManagementRecord {
  request: RuntimeRequest;
  info: BridgeUpdateInfo;
  confirmation: BridgeUpdateConfirmation | null;
  acknowledged: boolean;
}
export class BridgeManagementUpdate {
  private record: BridgeManagementRecord | undefined;
  private task: Promise<void> | null = null;
  private abort = new AbortController();
  constructor(private state: BridgeState, private driver?: BridgeManagementDriver) {
    this.record = state.bridgeUpdate();
  }
  get busy() { return !!this.record && !this.record.acknowledged; }
  get info() { return this.record?.info; }
  get capability() { return this.driver ? { platform: hostBridgePlatform(), safeRetry: true } : undefined; }
  private save(record: BridgeManagementRecord) { this.state.saveBridgeUpdate(record); this.record = record; }
  resume(operationId: string | null, version: string, instanceId: string) {
    if (!this.record || this.record.acknowledged) return;
    const record = this.record;
    if (record.info.operationId === operationId && ['restarting', 'verifying'].includes(record.info.status)) {
      this.save({ ...record, confirmation: null, info: { ...record.info, currentVersion: version, status: 'verifying', updatedAt: new Date().toISOString() } });
    } else if (record.confirmation && record.confirmation.instanceId === instanceId) return;
    else this.terminal('uncertain', version, instanceId);
  }
  async start(request: RuntimeRequest, version: string | null, instanceId: string, idle: () => boolean) {
    if (request.kind !== 'update-bridge' || request.status !== 'running' || request.conversationId !== null || Object.keys(request.payload).join(',') !== 'targetVersion') throw new Error('unsupported');
    z.string().uuid().parse(request.id);
    if (this.record?.request.id === request.id) {
      if (JSON.stringify(this.record.request.bridgeRelease) !== JSON.stringify(request.bridgeRelease) || this.record.request.payload.targetVersion !== request.payload.targetVersion) throw new Error('unsupported');
      return;
    }
    if (this.busy || this.task || !idle()) throw new Error('busy');
    if (!this.driver || !version || !request.bridgeRelease) throw new Error('update_bridge_unavailable');
    const plan = planSchema.parse(request.bridgeRelease);
    if (plan.fromVersion !== version || plan.fromInstanceId !== instanceId || plan.platform !== hostBridgePlatform()) throw new Error('update_bridge_manifest_invalid');
    const verified = verifyBridgeSnapshot(plan.snapshot, this.driver.keys, version);
    if (verified.manifestSha256 !== plan.manifestSha256 || verified.manifest.version !== request.payload.targetVersion) throw new Error('update_bridge_manifest_invalid');
    const previous = this.record;
    const retryProof = previous?.acknowledged && previous.info.status === 'failed' && previous.confirmation?.outcome === 'rolled-back' && previous.confirmation.instanceId === instanceId && previous.request.bridgeRelease && previous.request.payload.targetVersion === request.payload.targetVersion
      ? { operationId: previous.request.id, manifestSha256: previous.confirmation.manifestSha256, fromVersion: previous.request.bridgeRelease.fromVersion, targetVersion: previous.request.payload.targetVersion } : undefined;
    this.save({ request, confirmation: null, acknowledged: false, info: { supported: true, currentVersion: version, targetVersion: request.payload.targetVersion!, operationId: request.id, status: 'staging', error: null, updatedAt: new Date().toISOString() } });
    this.task = this.prepare(request, version, instanceId, retryProof).finally(() => { this.task = null; });
  }
  reject(request: RuntimeRequest, version: string | null, instanceId: string) {
    const plan = planSchema.safeParse(request.bridgeRelease);
    if (this.busy || this.task || this.record?.request.id === request.id || request.kind !== 'update-bridge' || request.conversationId !== null || !version || !plan.success || plan.data.fromVersion !== version || plan.data.fromInstanceId !== instanceId || request.status !== 'running' || !z.string().uuid().safeParse(request.id).success || !z.string().regex(/^\d+\.\d+\.\d+$/).max(64).safeParse(request.payload.targetVersion).success) return false;
    this.save({ request, confirmation: null, acknowledged: false, info: { supported: !!this.driver, currentVersion: version, targetVersion: request.payload.targetVersion!, operationId: request.id, status: 'failed', error: 'update_bridge_failed', updatedAt: new Date().toISOString() } });
    this.terminal('failed', version, instanceId);
    return true;
  }
  private async prepare(request: RuntimeRequest, version: string, instanceId: string, retryProof?: BridgeRetryProof) {
    let handedOff = false;
    try {
      const prepared = await this.driver!.prepare(request, this.abort.signal, retryProof);
      this.abort.signal.throwIfAborted();
      if (prepared.manifestSha256 !== request.bridgeRelease!.manifestSha256) throw new Error('Prepared digest mismatch');
      this.save({ ...this.record!, info: { ...this.record!.info, status: 'restarting', updatedAt: new Date().toISOString() } });
      handedOff = true;
      await this.driver!.notify({ type: 'bridge-update-ready', operationId: request.id, version: request.payload.targetVersion! });
    } catch (error) {
      this.terminal(handedOff || this.abort.signal.aborted || (error as NodeJS.ErrnoException).code === 'bridge_process_unconfirmed' ? 'uncertain' : 'failed', version, instanceId);
    }
  }
  private terminal(outcome: BridgeUpdateConfirmation['outcome'], version: string, instanceId: string) {
    if (!this.record) return;
    this.save({ ...this.record, acknowledged: false, confirmation: { operationId: this.record.request.id, instanceId, manifestSha256: this.record.request.bridgeRelease!.manifestSha256, outcome }, info: { ...this.record.info, currentVersion: version, status: outcome === 'succeeded' ? 'succeeded' : outcome === 'uncertain' ? 'uncertain' : 'failed', error: outcome === 'succeeded' ? null : outcome === 'uncertain' ? 'update_bridge_interrupted' : 'update_bridge_failed', updatedAt: new Date().toISOString() } });
  }
  observe(value: unknown, version: string, instanceId: string) {
    const parsed = z.object({ operationId: z.string().uuid(), fromVersion: z.string(), toVersion: z.string(), manifestSha256: z.string().nullable(), status: z.enum(['succeeded', 'failed', 'uncertain']), error: z.string().nullable(), updatedAt: z.string().optional() }).strict().safeParse(value);
    if (!parsed.success || !this.record || this.record.acknowledged || this.record.info.status === 'uncertain') return;
    const result = parsed.data, request = this.record.request;
    if (result.operationId !== request.id || result.fromVersion !== request.bridgeRelease!.fromVersion || result.toVersion !== request.payload.targetVersion) return;
    const validationFailed = result.status === 'failed' && result.error === 'validation_failed' && result.manifestSha256 === null && instanceId === request.bridgeRelease!.fromInstanceId && version === result.fromVersion;
    if (result.manifestSha256 !== request.bridgeRelease!.manifestSha256 && !validationFailed) return;
    if (result.status === 'succeeded' && version === result.toVersion) this.terminal('succeeded', version, instanceId);
    else if (result.status === 'failed' && version === result.fromVersion) this.terminal(instanceId === request.bridgeRelease!.fromInstanceId ? 'failed' : 'rolled-back', version, instanceId);
    else if (result.status === 'uncertain') this.terminal('uncertain', version, instanceId);
  }
  async publish(send: (confirmation: BridgeUpdateConfirmation) => Promise<void>) {
    if (!this.record || this.record.acknowledged) return;
    if (!this.record.confirmation) { await this.driver?.notify({ type: 'bridge-update-status' }); return; }
    const confirmation = this.record.confirmation;
    await send(confirmation);
    if (this.record.confirmation === confirmation && confirmation.outcome !== 'uncertain') this.save({ ...this.record, acknowledged: true });
  }
  async stop() { this.abort.abort(); await this.task; }
}

export function bridgeManagementDriver(root: string, configPath: string, keys: readonly string[], notify: BridgeManagementDriver['notify']): BridgeManagementDriver {
  return { keys, notify, prepare: (request, signal, retryProof) => prepareBridgeRelease(request.id, request.bridgeRelease!.snapshot, { root, configPath, trustedPublicKeys: keys, currentVersion: request.bridgeRelease!.fromVersion, signal, retryProof }) };
}
