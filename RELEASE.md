# Release and Host Update Contract

## Notification summary release 0.1.8

Deploy the gateway supporting completed `process.summary` before this version. Final replies are correlated to the same native turn locally; only completed turns carry a bounded excerpt in their durable terminal records. Missing final replies never borrow another turn's text. Permissions, native CLI, signing keys and Supervisor contracts are unchanged. Gateway tests cover the simulated native lifecycle; real model and notification delivery acceptance are separate.

## Release inputs

Release tags use semantic versions such as `v1.2.3`. A release contains a platform bundle, `manifest.json`, `checksums.txt`, an SBOM and a provenance attestation. The release workflow must run from a protected environment and must not accept arbitrary artifact paths from a caller.

## Signed manifest generation (local implementation, not yet released)

The publish job now runs `scripts/create-release-manifest.mjs` after downloading all three platform artifacts. It computes each archive's byte length and SHA-256 directly, rejecting missing, empty, oversized, non-regular and symlink assets. The stable version must match the fixed archive names. Output is written as a pair under `release/manifest-bundle/`; an existing non-empty bundle is not overwritten.

The protected GitHub `release` environment must contain `BRIDGE_MANIFEST_SIGNING_KEY`, an unencrypted PKCS#8 PEM Ed25519 private key. Only the generation step receives it. A missing or invalid key fails the release instead of publishing an unsigned manifest. CLI failures use a generic diagnostic and do not print keys or exception details. Do not put the key in this repository, a release asset, an argument, an issue or a chat message.

Generate and store the production key through the owner's private administration process; this change does not create a production key or configure GitHub secrets. Pin the corresponding SPKI PEM public key independently in gateway/host trust configuration before enabling update discovery. Never derive trust from a public key downloaded alongside a manifest. Public-key fingerprints can be checked out of band. For rotation, distribute the new public key first, then change the signing secret; remove retired public keys explicitly. Removing a key cannot revoke already downloaded/executed code.

The release publishes `manifest.json` and `manifest.sig.json`. The signature envelope is:

```json
{"schemaVersion":1,"algorithm":"ed25519","keyId":"<64 lowercase hex>","signature":"<canonical base64>"}
```

`keyId` is SHA-256 of the signer's DER-encoded SPKI public key. Ed25519 signs the following exact byte concatenation, with no JSON reserialization at verification time:

```text
UTF8("agent-inbox-bridge-manifest:v1\n" + keyId + "\n") || manifest.json bytes
```

The manifest v1 body contains `schemaVersion`, the fixed repository, `version`, `publishedAt`, `expiresAt`, and exactly three `assets` with `platform/name/size/sha256`. Current limits match the gateway contract: 16 KiB manifest, 256 MiB per archive, seven days validity, and stable three-part versions only. Expired immutable releases must not have their timestamps silently changed; publish a new reviewed release. A separate renewable signed index is not implemented.

Existing archive provenance remains, and the publish job also attests `manifest.json`. The Ed25519 verifier authenticates the manifest; it does not itself verify GitHub provenance. Local discovery, host download verification, isolated extraction and Supervisor switching now have implementations and tests. The gateway has a dedicated allowlisted Canary admission route; ordinary Agents and the generic update operation remain disabled. The workflow changes have only local validation until a protected tag build is performed.

Cross-repository conformance checks live in the gateway test suite. From the gateway checkout run `BRIDGE_RELEASE_PROJECT=/path/to/bridge-checkout node --import tsx --test tests/bridge-release*.test.ts`. They use temporary assets and in-memory test keys, not release credentials. Without the explicit checkout path, the publisher integration test skips; gateway signature tests still run. This Bridge project's current `npm test` has no built-in cases and is not evidence that publishing or upgrading works.

## Host layout

The supervisor owns a private directory:

```text
~/.agent-inbox/codex-bridge/
├── versions/<version>/
├── current -> versions/<version>
├── previous -> versions/<version>
├── downloads/
└── state/
```

The service manager starts the fixed supervisor path, never a versioned Bridge path. The host preparer verifies the signed snapshot, archive length/digest and safe extraction, then runs the fixed validation command. CI bundles production dependencies with `npm ci --omit=dev --ignore-scripts` and a tag-derived `bridge-version.json`; the host does not install dependencies. The Supervisor verifies the operation-bound receipt before stopping the old child, atomically switches `current`, and waits for nonce-correlated readiness. A failed health check rolls back; an unconfirmed App Server shutdown forbids starting a replacement. Local readiness is not gateway completion evidence.

CI also passes `--no-bin-links` so npm does not create `.bin` symlinks rejected by safe extraction; Bridge imports its dependencies directly and does not need package CLI shims.

Packaging sets `COPYFILE_DISABLE=1` to exclude macOS AppleDouble metadata outside the expected archive root. Do not weaken path or symlink checks to accommodate packaging artifacts. Cross-repository host tests package the real compiled output with offline production dependencies and run the actual `--validate` entrypoint; network assets and signing keys are still fixtures, not production release acceptance.

Updates require explicit `AGENT_INBOX_BRIDGE_UPDATES=1` and independently provisioned `BRIDGE_RELEASE_PUBLIC_KEYS_FILE` (a JSON array of pinned SPKI PEM public keys). The management handler prepares the frozen `bridgeRelease` snapshot and emits nonce-correlated `bridge-update-ready`; these flags alone do not enable remote self-update. The gateway must separately allowlist the Agent through `BRIDGE_UPDATE_CANARY_AGENT_IDS`, configure trust and admit an Owner-selected verified release through its dedicated Canary endpoint. Runtime polls carry the registered `instanceId`. Installed expanded files rely on the private host directory boundary; the receipt is not a per-file integrity inventory.

The host SQLite `bridge_update` record retains the original operation, signed plan, maintenance phase and pending confirmation across replacement. Maintenance is acquired before asynchronous preparation; input, configuration changes and conflicting updates stay blocked until gateway acknowledgement. Supervisor terminal results can be retrieved by read-only `bridge-update-status` IPC without replaying a switch. A replacement verifies the original operation/version/digest and submits `bridgeConfirmation`; rollback is failure, not target success. Lost result responses retry only the identical confirmation. Uncertain outcomes, interrupted staging and uncorrelated restarts remain locked for manual recovery.

The gateway coordinator freezes prior registration identity and thread/settings evidence, validates fresh replacement registration and native readiness, and persists terminal confirmation atomically. Canary HTTP routes retain Owner and dual-token management authentication; ordinary Agent updates stay closed. Local tests use fixture releases and fake App Server processes, with separate HTTP routing coverage; they are not real remote runtime or deployment acceptance. Gateway restart, revoked credentials and expired operations cannot be retroactively completed or executed again.

Instance and conversation runtime reports carry `codexInstanceId`, bound to the current registration rather than a channel or native thread ID. The internal updater requires current-instance native settings reports for existing threads; legacy reports without identity remain compatible with ordinary management but cannot attest replacement recovery. A well-formed request rejected before preparation is durably reported as failure, without invoking the downloader; lost rejection responses retry the result rather than executing the rejected request.

`state/supervisor.lock` is exclusive and never automatically stolen. Following a crash, an operator must first confirm that the owned Bridge/App Server process tree is gone before clearing a stale lock. Only then may `--recover-clean-host` (after root and config arguments) roll back an interrupted journal; an `uncertain` record requires separate investigation. Never delete state to force a second live Bridge. The v0.1.3 baseline lacks the new IPC/identity contract, so initial migration requires manual installation of the compatible bundle and fixed Supervisor. Switching Bridge versions does not upgrade the fixed Supervisor itself.

## User-facing update domains

The product exposes two concepts only:

1. **Agent runtime** — the Bridge and the App Server lifecycle managed by it.
2. **Codex environment** — the Codex CLI and user-level Codex configuration, including managed model providers.

The wire protocol may keep separate operation IDs for rollback and audit. This separation is not exposed as additional user-facing products.

## Provider configuration

Managed providers use a Bridge-owned namespace and an environment-backed credential. Local entries outside that namespace are never overwritten. A configuration change is acknowledged only after the Bridge has reloaded the App Server and re-read the effective provider inventory. A visible provider is not proof that a model request will succeed.
