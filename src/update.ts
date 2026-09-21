import childProcess from 'node:child_process';
import { parseCodexVersion } from './version.js';

export interface CodexUpdateOptions { signal?: AbortSignal; timeoutMs?: number; cwd?: string }
export type CodexUpdateCode = 'completed' | 'unsupported-platform' | 'spawn-failed' | 'exit-failed' | 'timeout' | 'cancelled' | 'output-limit' | 'cleanup-failed';
export interface CodexUpdateResult { ok: boolean; code: CodexUpdateCode }
export interface CodexUpdateProbe {
  available: boolean;
  reason: 'supported' | 'unsupported-platform' | 'unavailable' | 'timeout' | 'cancelled';
}

const outputLimit = 64 * 1024;
const exitGraceMs = 1_000;
const supportedPlatform = () => process.platform === 'darwin' || process.platform === 'linux';

/** Local options only: callers cannot supply command arguments, URLs, versions or a shell. */
function timeout(options: CodexUpdateOptions, maximum: number): number {
  return Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(options.timeoutMs!, maximum)) : maximum;
}

/**
 * Run only one of the three fixed native commands below. Output never leaves this
 * module. POSIX process groups cover the CLI wrapper and installer descendants;
 * Windows stays unavailable until equivalent process-tree ownership is provided.
 */
function run(binary: string, args: readonly string[], options: CodexUpdateOptions, maximum: number, captureOutput: boolean): Promise<CodexUpdateResult & { output: string }> {
  if (!supportedPlatform()) return Promise.resolve({ ok: false, code: 'unsupported-platform', output: '' });
  if (options.signal?.aborted) return Promise.resolve({ ok: false, code: 'cancelled', output: '' });
  return new Promise(resolve => {
    let child: ReturnType<typeof childProcess.spawn>;
    try {
      child = childProcess.spawn(binary, [...args], { cwd: options.cwd, shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, code: 'spawn-failed', output: '' });
      return;
    }
    let output = '', bytes = 0, exited = false, settled = false, stopping: CodexUpdateCode | null = null;
    let exitTimer: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => stop('timeout'), timeout(options, maximum));
    const abort = () => stop('cancelled');

    function finish(code: CodexUpdateCode) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline); clearTimeout(exitTimer);
      options.signal?.removeEventListener('abort', abort);
      child.stdout?.destroy(); child.stderr?.destroy();
      resolve({ ok: code === 'completed', code, output: code === 'completed' ? output : '' });
    }
    function killGroup(): 'sent' | 'gone' | 'failed' {
      // Once libuv has reaped the group leader, its PGID can be reused. Never
      // signal a cached ID after exit, even when descendants hold stdio open.
      if (!child.pid || child.pid <= 1 || child.pid === process.pid || exited || child.exitCode != null || child.signalCode != null) return 'failed';
      try { process.kill(-child.pid, 'SIGKILL'); return 'sent'; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'failed'; }
    }
    function stop(code: CodexUpdateCode) {
      if (settled || stopping) return;
      stopping = code;
      clearTimeout(deadline);
      if (code === 'spawn-failed' && !child.pid) { finish(code); return; }
      // Send one group kill while the leader is still owned. A TERM grace period
      // could let the wrapper exit and release the PGID before escalation. An
      // interrupted installation is always uncertain; callers retain maintenance.
      exitTimer = setTimeout(() => finish('cleanup-failed'), exitGraceMs);
      if (killGroup() === 'failed') finish('cleanup-failed');
    }
    const drain = (chunk: Buffer, stdout: boolean) => {
      if (settled || stopping) return;
      bytes += chunk.length;
      if (bytes > outputLimit) { stop('output-limit'); return; }
      if (stdout && captureOutput) output += chunk.toString('utf8');
    };
    child.stdout?.on('data', (chunk: Buffer) => drain(chunk, true));
    child.stderr?.on('data', (chunk: Buffer) => drain(chunk, false));
    child.on('error', () => stop('spawn-failed'));
    child.on('exit', () => { exited = true; });
    child.on('close', (code, signal) => {
      // Ordinary completion requires no signals. In particular, never address
      // the old group here: its leader has already been reaped.
      finish(stopping ?? (code === 0 && signal === null ? 'completed' : 'exit-failed'));
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    // An abort may have occurred between the initial check and listener setup.
    if (options.signal?.aborted) abort();
  });
}

/** Help is read-only and proves only command recognition, not install permission or unattended success. */
export async function probeCodexUpdate(binary: string, options: CodexUpdateOptions = {}): Promise<CodexUpdateProbe> {
  const result = await run(binary, ['update', '--help'], options, 5_000, true);
  if (result.ok && /^Usage:\s+codex update(?:\s|$)/m.test(result.output)) return { available: true, reason: 'supported' };
  const reason = result.code === 'unsupported-platform' || result.code === 'timeout' || result.code === 'cancelled' ? result.code : 'unavailable';
  return { available: false, reason };
}

/** Installed version is separate from the version obtained by App Server initialize. */
export async function readCodexInstalledVersion(binary: string, options: CodexUpdateOptions = {}): Promise<string | null> {
  const result = await run(binary, ['--version'], options, 5_000, true);
  if (!result.ok) return null;
  const match = /^codex-cli ([^\s]+)$/.exec(result.output.trim());
  return match ? parseCodexVersion(`codex_cli_rs/${match[1]}`) : null;
}

/**
 * Completion means exit 0 only. Callers must verify the installed version and a
 * fresh App Server handshake; an unchanged version never proves it is latest.
 * Failed/aborted updates may have modified the installation. Never retry them
 * automatically. A group kill is best effort, not proof that descendants which
 * created their own session have exited. cleanup-failed also means the wrapper
 * could not be confirmed closed or its group was no longer safe to address.
 */
export async function runCodexUpdate(binary: string, options: CodexUpdateOptions = {}): Promise<CodexUpdateResult> {
  const { ok, code } = await run(binary, ['update'], options, 5 * 60_000, false);
  return { ok, code };
}
