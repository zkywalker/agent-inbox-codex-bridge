# Native update and host maintenance

Codex and Bridge upgrades are separate operations. A Bridge release does not install a new Codex CLI automatically.

## Enable Codex updates

Keep the existing private configuration and merge `"allowNativeUpdate": true` only after checking the exact `codexBinary` under the service account and service environment. Run that entrypoint's `--version` and `update --help`, then this package's `--validate CONFIG`. A working terminal Codex or a still-running App Server is not evidence that the configured launcher is valid.

Optional `nativeUpdateRegistry` selects a trusted HTTPS npm registry for the fixed `codex update` child process. Example (placeholder, not an active service):

```json
{
  "allowNativeUpdate": true,
  "nativeUpdateRegistry": "https://npm-mirror.example/"
}
```

Omit the registry to preserve the service's existing package-manager configuration. No mirror is chosen automatically. URLs cannot contain credentials, whitespace, query parameters or fragments. Registry settings are not sent by the gateway, written to public reports or applied to global npm configuration. The mirror does not itself enable updates.

The registry is inherited only when native update uses npm; it is not a universal binary-download proxy. Scoped npm configuration and absolute tarball URLs can affect the actual source. Mirrors must contain the main package and the platform-specific optional dependency and may lag upstream. No certificate or integrity checks are disabled, and a failed or uncertain install is never automatically retried against a different source.

## Maintenance boundary

All managed topics must be idle and incoming work paused before maintenance. Back up private configuration, service definitions, stopped SQLite state, version pointers and any fixed Supervisor files. Do not replace `codexBinary` with a different installation just because it is on PATH. Version-manager paths can disappear when old Node installations are removed; retain the intended installation and its compatible service PATH.

Validate new configuration with the candidate release before stopping the healthy service. Version 0.1.12 ships a strict configuration contract, single-instance host locks, read-only diagnostics and bounded Supervisor retries. A fixed Supervisor must be updated separately during the same stopped-service maintenance window to use the new preflight and retry policy; updating only `current` does not update fixed files. Do not use these scripts to skip signed-release verification.

`scripts/service-control.mjs` accepts either the fixed root Supervisor or the legacy versioned Supervisor, verifies its configured root/configuration and refuses busy or uncertain restarts. Start/restart commands do not delete state, steal locks or rebind native threads. Confirmed clean shutdown and matching runtime-version evidence remain required for update success.

Use `node dist/src/main.js --config-contract` to inspect supported fields, `--validate CONFIG` to preflight, and `--diagnose CONFIG ROOT` for read-only health. These commands do not execute model input. If shutdown or installation is uncertain, use an independent host-maintenance channel rather than asking a broken conversation to repair itself.
