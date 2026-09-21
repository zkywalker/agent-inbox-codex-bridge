import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface RpcMessage { id?: string | number; method?: string; params?: any; result?: any; error?: { code: number; message: string } }
export class RpcError extends Error {
  constructor(message: string, readonly code?: number, readonly uncertain = false) { super(message); }
}

/** One private child process, one JSONL transport. Never expose an unauthenticated listener. */
export class CodexRpc {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private ended = false;
  private exited = false;
  private closed = false;
  private closing: Promise<void> | null = null;
  private readonly ownsProcessGroup = process.platform === 'darwin' || process.platform === 'linux';
  onMessage: (message: RpcMessage) => void = () => {};
  onExit: (error: Error) => void = () => {};
  onDiagnostic: (text: string) => void = () => {};
  constructor(binary: string, args = ['app-server', '--listen', 'stdio://'], cwd?: string, env?: NodeJS.ProcessEnv) {
    this.child = childProcess.spawn(binary, args, { cwd, env: env ? { ...process.env, ...env } : undefined, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: this.ownsProcessGroup });
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    this.child.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (buffer.length > 32 * 1024 * 1024) { this.fail(new RpcError('Codex JSONL frame exceeds limit', undefined, true)); this.child.kill(); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); }
        catch { this.fail(new RpcError('Invalid Codex JSONL response', undefined, true)); this.child.kill(); return; }
      }
    });
    // Drain diagnostics without leaking provider headers, private configuration or credentials.
    this.child.stderr.on('data', (chunk: Buffer) => this.onDiagnostic(chunk.toString('utf8')));
    this.child.stdin.on('error', () => this.fail(new RpcError('Codex input transport closed', undefined, true)));
    this.child.on('error', () => this.fail(new RpcError('Cannot start Codex App Server')));
    this.child.on('exit', (code, signal) => { this.exited = true; this.fail(new RpcError(`Codex App Server exited (${code ?? signal})`, undefined, true)); });
    this.child.on('close', () => { this.closed = true; });
  }
  private receive(message: RpcMessage) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id)); clearTimeout(pending.timer);
      if (message.error) pending.reject(new RpcError(message.error.message, message.error.code));
      else pending.resolve(message.result);
    } else this.onMessage(message);
  }
  private write(message: RpcMessage) {
    if (this.ended) throw new RpcError('Codex transport is offline', undefined, true);
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request<T = any>(method: string, params: unknown = {}, timeout = 45_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcError(`Codex ${method} timed out; outcome unknown`, undefined, true)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method: string, params?: unknown) { this.write({ method, ...(params === undefined ? {} : { params }) }); }
  respond(id: string | number, result: unknown) { this.write({ id, result }); }
  reject(id: string | number, message: string) { this.write({ id, error: { code: -32601, message } }); }
  private fail(error: Error) {
    if (this.ended) return;
    this.ended = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.onExit(error);
  }
  close() { this.child.kill('SIGTERM'); this.fail(new RpcError('Codex bridge stopped', undefined, true)); }
  closeAndWait(timeoutMs = 5_000): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closing) return this.closing;
    const waitMs = Number.isFinite(timeoutMs) ? Math.max(50, Math.min(timeoutMs, 5_000)) : 5_000;
    this.closing = new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true; clearTimeout(kill); clearTimeout(deadline); this.child.off('close', onClose);
        if (error) reject(error); else resolve();
      };
      const unconfirmed = () => new RpcError('Codex child termination unconfirmed', undefined, true);
      const onClose = () => finish();
      const kill = setTimeout(() => {
        // The npm wrapper inherits the native server's stdio. Wrapper exit alone
        // is insufficient: await close, which also waits for those streams.
        // Never signal a PGID after its leader was reaped and may have been reused.
        if (!this.ownsProcessGroup || this.exited || this.child.exitCode !== null || this.child.signalCode !== null || !this.child.pid || this.child.pid <= 1 || this.child.pid === process.pid) { finish(unconfirmed()); return; }
        try { process.kill(-this.child.pid, 'SIGKILL'); }
        catch { finish(unconfirmed()); }
      }, Math.min(3_000, waitMs / 2));
      const deadline = setTimeout(() => finish(unconfirmed()), waitMs);
      this.child.once('close', onClose);
      // EOF reaches the actual App Server through an npm wrapper as well. Keep
      // ordinary close() unchanged; controlled restart requires stronger proof.
      this.fail(new RpcError('Codex bridge stopped', undefined, true));
      this.child.stdin.end();
    });
    return this.closing;
  }
}
