import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function preflight(directory, config, timeoutMs = 30_000) {
  const contract = JSON.parse(await readFile(join(directory, 'config-contract.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return 'null';
    throw error;
  }));
  if (contract && (contract.kind !== 'agent-inbox-codex-config' || contract.version !== 1)) throw new Error('config_invalid');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(directory, 'dist/src/main.js'), '--validate', config], { cwd: directory, stdio: 'ignore', shell: false });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); reject(new Error('config_invalid')); });
    child.once('close', code => { clearTimeout(timer); code === 0 && !timedOut ? resolve() : reject(new Error(code === 69 ? 'codex_unavailable' : 'config_invalid')); });
  });
}

export class RestartPolicy {
  failures = 0;
  constructor({ limit = 5, baseMs = 5000, maxMs = 60_000 } = {}) { this.limit = limit; this.baseMs = baseMs; this.maxMs = maxMs; }
  next() { this.failures++; return this.failures >= this.limit ? null : Math.min(this.baseMs * 2 ** (this.failures - 1), this.maxMs); }
}
