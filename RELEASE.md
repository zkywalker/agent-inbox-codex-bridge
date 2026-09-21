# Release and Host Update Contract

## Release inputs

Release tags use semantic versions such as `v1.2.3`. A release contains a platform bundle, `manifest.json`, `checksums.txt`, an SBOM and a provenance attestation. The release workflow must run from a protected environment and must not accept arbitrary artifact paths from a caller.

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

The service manager starts the fixed supervisor path, never a versioned Bridge path. The supervisor installs a staged version, verifies its digest and signature, runs the Bridge validation command, atomically switches `current`, restarts the child and waits for a fresh gateway registration. A failed health check switches back to `previous`.

## User-facing update domains

The product exposes two concepts only:

1. **Agent runtime** — the Bridge and the App Server lifecycle managed by it.
2. **Codex environment** — the Codex CLI and user-level Codex configuration, including managed model providers.

The wire protocol may keep separate operation IDs for rollback and audit. This separation is not exposed as additional user-facing products.

## Provider configuration

Managed providers use a Bridge-owned namespace and an environment-backed credential. Local entries outside that namespace are never overwritten. A configuration change is acknowledged only after the Bridge has reloaded the App Server and re-read the effective provider inventory. A visible provider is not proof that a model request will succeed.
