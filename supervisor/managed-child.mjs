import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export class ManagedBridgeChild {
  child = null;
  closed = true;
  stopped = true;
  ready = false;
  nonce = null;
  stopping = null;
  constructor({ root, config, readyTimeoutMs = 60_000, stopTimeoutMs = 40_000, settleMs = 2000, onExit = () => {}, onUpdate = () => {} }) {
    this.root = root; this.config = config; this.readyTimeoutMs = readyTimeoutMs; this.stopTimeoutMs = stopTimeoutMs;
    this.settleMs = settleMs; this.onExit = onExit; this.onUpdate = onUpdate;
  }
  async start(version, operationId = null) {
    if (!this.closed || !this.stopped) throw new Error('Previous Bridge stop is unconfirmed');
    const nonce = randomUUID();
    const child = spawn(process.execPath, [join(this.root, 'versions', version, 'dist/src/main.js'), this.config], {
      cwd: join(this.root, 'versions', version), shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, AGENT_INBOX_BRIDGE_ROOT: this.root, BRIDGE_SUPERVISOR_NONCE: nonce, BRIDGE_UPDATE_OPERATION_ID: operationId ?? '' },
    });
    this.child = child; this.closed = false; this.stopped = false; this.ready = false; this.nonce = nonce;
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    const readiness = new Promise((resolveReady, reject) => {
      let done = false, settle;
      const finish = error => { if (done) return; done = true; clearTimeout(deadline); clearTimeout(settle); if (error) reject(error); else resolveReady(); };
      const deadline = setTimeout(() => finish(new Error('Bridge readiness timed out')), this.readyTimeoutMs);
      child.on('message', message => {
        if (this.child !== child || !message || message.nonce !== nonce) return;
        if (message.type === 'bridge-stopped') this.stopped = true;
        if (message.type === 'bridge-ready' && message.version === version && message.operationId === operationId && typeof message.instanceId === 'string' && /^[0-9a-f-]{36}$/i.test(message.instanceId)) {
          this.ready = true;
          if (!settle) settle = setTimeout(() => finish(), this.settleMs);
        }
        if (['bridge-update-ready', 'bridge-update-status'].includes(message.type) && this.ready) this.onUpdate(message);
      });
      child.once('error', () => { if (!child.pid) this.stopped = true; finish(new Error('Bridge child unavailable')); });
      child.once('close', () => {
        this.closed = true; this.ready = false;
        finish(new Error('Bridge closed before readiness')); this.onExit();
      });
      if (!operationId) finish();
    });
    await readiness;
  }
  async stop() {
    if (this.stopping) return this.stopping;
    if (this.closed) { if (!this.stopped) throw new Error('Bridge stop unconfirmed'); return; }
    const child = this.child;
    this.stopping = new Promise((resolveStop, reject) => {
      const finish = () => { clearTimeout(deadline); child.off('close', onClose); this.stopped ? resolveStop() : reject(new Error('Bridge App Server stop unconfirmed')); };
      const onClose = () => finish();
      const deadline = setTimeout(() => { child.off('close', onClose); reject(new Error('Bridge stop timed out')); }, this.stopTimeoutMs);
      child.once('close', onClose);
      if (child.connected) child.send({ type: 'bridge-supervisor-stop', nonce: this.nonce }, () => {});
    }).finally(() => { this.stopping = null; });
    return this.stopping;
  }
  notifyUpdate(result) {
    if (!this.child?.connected || !this.ready || !['succeeded', 'failed', 'uncertain'].includes(result?.status)) return;
    this.child.send({ type: 'bridge-update-result', nonce: this.nonce, result }, () => {});
  }
}
