import { randomUUID } from 'node:crypto';
import { mkdir, open, readlink, realpath, rename, symlink, unlink, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const operationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const active = ['validating', 'stopping', 'switching', 'verifying', 'rolling-back'];
const statuses = [...active, 'succeeded', 'failed', 'uncertain'];
const validVersion = value => typeof value === 'string' && value.length <= 64 && versionPattern.test(value);

export async function syncDirectory(path) {
  const directory = await open(path, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}
export class BridgeUpdateController {
  busy = false;
  constructor({ root, stop, start, validate }) {
    this.root = resolve(root); this.stop = stop; this.start = start; this.validate = validate;
    this.state = join(this.root, 'state'); this.journal = join(this.state, 'bridge-update.json');
  }
  async initialize() {
    if (await realpath(this.root) !== this.root) throw new Error('Unsafe Supervisor root');
    await mkdir(this.state, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (await realpath(this.state) !== this.state || !(await lstat(this.state)).isDirectory()) throw new Error('Unsafe Supervisor state');
  }
  async currentVersion() {
    const target = await readlink(join(this.root, 'current'));
    const version = target.startsWith('versions/') ? target.slice(9) : '';
    await this.versionDirectory(version);
    return version;
  }
  async versionDirectory(version) {
    if (!validVersion(version)) throw new Error('Invalid Supervisor version');
    const directory = join(this.root, 'versions', version);
    if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) throw new Error('Unsafe Supervisor version directory');
    return directory;
  }
  async read() {
    let file;
    try { file = await open(this.journal, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 4096) throw new Error('Invalid Supervisor journal');
      const value = JSON.parse(await file.readFile('utf8'));
      if (!value || Object.keys(value).some(key => !['operationId', 'fromVersion', 'toVersion', 'manifestSha256', 'status', 'error', 'updatedAt'].includes(key))
        || !operationPattern.test(value.operationId) || !validVersion(value.fromVersion) || !validVersion(value.toVersion)
        || !(value.manifestSha256 === null || typeof value.manifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.manifestSha256))
        || !statuses.includes(value.status) || ![null, 'validation_failed', 'startup_failed', 'rollback_failed', 'interrupted', 'stop_unconfirmed'].includes(value.error)
        || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error('Invalid Supervisor journal');
      return value;
    } finally { await file.close(); }
  }
  async record(value) {
    const temporary = join(this.state, `.update-${randomUUID()}`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ ...value, updatedAt: new Date().toISOString() })); await file.sync(); }
    finally { await file.close(); }
    try { await rename(temporary, this.journal); await syncDirectory(this.state); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async point(name, version) {
    if (name !== 'current' && name !== 'previous') throw new Error('Invalid Supervisor link');
    await this.versionDirectory(version);
    const temporary = join(this.root, `.link-${randomUUID()}`);
    await symlink(`versions/${version}`, temporary);
    try { await rename(temporary, join(this.root, name)); await syncDirectory(this.root); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async rollback(record) {
    await this.record({ ...record, status: 'rolling-back' });
    try {
      await this.point('current', record.fromVersion);
      await this.start(record.fromVersion, record.operationId);
      const result = { ...record, status: 'failed', error: 'startup_failed' };
      await this.record(result); return result;
    } catch {
      const result = { ...record, status: 'uncertain', error: 'rollback_failed' };
      await this.record(result); return result;
    }
  }
  async switchTo({ operationId, version }) {
    if (this.busy || !operationPattern.test(operationId) || !validVersion(version)) throw new Error('Invalid or busy Supervisor update');
    this.busy = true;
    try {
      const prior = await this.read();
      if (prior?.operationId === operationId) { if (prior.toVersion !== version) throw new Error('Supervisor operation target mismatch'); return prior; }
      if (prior && (active.includes(prior.status) || prior.status === 'uncertain')) throw new Error('Supervisor recovery required');
      const fromVersion = await this.currentVersion();
      if (fromVersion === version) throw new Error('Supervisor target already current');
      const record = { operationId, fromVersion, toVersion: version, manifestSha256: null, status: 'validating', error: null };
      await this.record(record);
      try {
        const proof = await this.validate(version, operationId, fromVersion);
        if (!proof || !/^[a-f0-9]{64}$/.test(proof.manifestSha256)) throw new Error('Supervisor validation proof missing');
        record.manifestSha256 = proof.manifestSha256;
        await this.point('previous', fromVersion);
      }
      catch { const result = { ...record, status: 'failed', error: 'validation_failed' }; await this.record(result); return result; }
      await this.record({ ...record, status: 'stopping' });
      try { await this.stop(); }
      catch { const result = { ...record, status: 'uncertain', error: 'stop_unconfirmed' }; await this.record(result); return result; }
      try {
        await this.record({ ...record, status: 'switching' });
        await this.point('current', version);
        await this.record({ ...record, status: 'verifying' });
        await this.start(version, operationId);
        const result = { ...record, status: 'succeeded' };
        await this.record(result); return result;
      } catch {
        try { await this.stop(); }
        catch { const result = { ...record, status: 'uncertain', error: 'stop_unconfirmed' }; await this.record(result); return result; }
        return await this.rollback(record);
      }
    } finally { this.busy = false; }
  }
  async recover() {
    const record = await this.read();
    if (!record || !active.includes(record.status)) return record;
    if (this.busy) throw new Error('Supervisor is busy');
    this.busy = true;
    try {
      const current = await this.currentVersion();
      if (![record.fromVersion, record.toVersion].includes(current)) throw new Error('Supervisor current pointer differs from journal');
      if (record.status === 'validating' && current === record.fromVersion) {
        const result = { ...record, status: 'failed', error: 'interrupted' }; await this.record(result); return result;
      }
      try { await this.stop(); }
      catch { const result = { ...record, status: 'uncertain', error: 'stop_unconfirmed' }; await this.record(result); return result; }
      return await this.rollback(record);
    } finally { this.busy = false; }
  }
}
