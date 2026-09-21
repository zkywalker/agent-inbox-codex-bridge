# Security Policy

## Supported versions

Only the latest release and the previous stable release receive security fixes.

## Reporting

Do not open a public issue containing credentials, private configuration, host paths or exploit details. Use the repository's private security advisory flow.

## Design rules

- The bridge accepts only authenticated outbound HTTPS requests to the configured gateway origin.
- Management credentials are separate from message credentials.
- Remote requests never contain shell commands, arbitrary URLs or arbitrary host paths.
- Release artifacts are verified before activation and are installed through a supervisor with rollback.
- Provider credentials are never emitted in reports, messages or diagnostics.
