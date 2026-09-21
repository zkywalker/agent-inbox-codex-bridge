// The App Server uses the client's name or its host's originator override as
// the product, followed by the binary version, not initialize.clientInfo.version.
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseCodexVersion(userAgent: unknown): string | null {
  if (typeof userAgent !== 'string' || userAgent.length > 4096) return null;
  // Only the initial product is authoritative; OS/terminal versions and other
  // host details in the remaining user agent must never become a version report.
  const version = /^(?:agent_inbox|codex_cli_rs|Codex Desktop)\/([^\s]+)(?:[ \t]|$)/.exec(userAgent)?.[1];
  return version && version.length <= 256 && semver.test(version) ? version : null;
}
