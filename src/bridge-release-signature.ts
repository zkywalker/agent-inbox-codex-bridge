import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { BRIDGE_MANIFEST_SIGNATURE_DOMAIN } from '../shared/bridge-release.js';
import { MAX_BRIDGE_MANIFEST_BYTES, parseUntrustedBridgeManifest } from './bridge-release-schema.js';

export const MAX_BRIDGE_SIGNATURE_BYTES = 2048;
const signatureSchema = z.object({
  schemaVersion: z.literal(1),
  algorithm: z.literal('ed25519'),
  keyId: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
}).strict();

export function verifyBridgeReleaseManifest(manifestInput: Uint8Array, signatureInput: Uint8Array, options: { trustedPublicKeys: readonly string[]; currentVersion: string; now: number }) {
  if (manifestInput.byteLength > MAX_BRIDGE_MANIFEST_BYTES || signatureInput.byteLength > MAX_BRIDGE_SIGNATURE_BYTES) throw new Error('Bridge signature input exceeds size limit');
  if (!options.trustedPublicKeys.length || options.trustedPublicKeys.length > 16) throw new Error('Bridge manifest trust is not configured');
  const manifestBytes = Buffer.from(manifestInput), signatureBytes = Buffer.from(signatureInput);
  const envelope = signatureSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(signatureBytes)));
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== envelope.signature) throw new Error('Invalid Bridge signature encoding');
  const keys = options.trustedPublicKeys.map(pem => {
    if (pem.length > 4096 || !pem.startsWith('-----BEGIN PUBLIC KEY-----')) throw new Error('Invalid Bridge trust key');
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Bridge trust requires Ed25519 public keys');
    const keyId = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
    return { key, keyId };
  });
  const trusted = keys.find(key => key.keyId === envelope.keyId);
  if (!trusted) throw new Error('Bridge signer is not trusted');
  const signedBytes = Buffer.concat([Buffer.from(`${BRIDGE_MANIFEST_SIGNATURE_DOMAIN}${envelope.keyId}\n`), manifestBytes]);
  if (!verify(null, signedBytes, trusted.key, signature)) throw new Error('Bridge manifest signature verification failed');
  const manifest = parseUntrustedBridgeManifest(manifestBytes, options);
  return {
    manifest,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    signerKeyId: envelope.keyId,
  };
}
