import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { x as unpackTar, t as inspectTar, type ReadEntry } from 'tar';
import { resolve } from 'node:path';

async function unpack() {
  if (process.argv.length !== 7) throw new Error('Invalid unpack arguments');
  const [archive, staging, expectedRoot, expectedSize, expectedDigest] = process.argv.slice(2);
  const size = Number(expectedSize);
  if (!/^codex-bridge-\d+\.\d+\.\d+-(darwin-x64|darwin-arm64|linux-x64)$/.test(expectedRoot) || !Number.isSafeInteger(size) || size < 1 || size > 256 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(expectedDigest) || await realpath(staging) !== resolve(staging)) throw new Error('Invalid unpack input');
  const file = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error('Archive is not a file');
    for (const extracting of [false, true]) {
      const entries = new Set<string>(); let fileBytes = 0, expanded = 0, compressed = 0;
      const hash = createHash('sha256');
      const filter = (path: string, rawEntry: unknown) => {
        const entry = rawEntry as ReadEntry, parts = path.replace(/\/$/, '').split('/');
        const key = parts.join('/').toLowerCase(); fileBytes += entry.size;
        const invalid = parts[0] !== expectedRoot || parts.some(part => !part || part === '.' || part === '..' || /[\\:\u0000]/.test(part))
          || parts.length > 32 || !['File', 'Directory'].includes(entry.type) || entries.has(key) || entries.size >= 20_000
          || entry.size > 64 * 1024 * 1024 || fileBytes > 512 * 1024 * 1024 || parts[1] === '.bridge-update.json';
        if (invalid) { parser.abort(new Error('Unsafe archive entry')); return false; }
        entries.add(key); entry.mode = entry.type === 'Directory' ? 0o700 : 0o600; return true;
      };
      const parser = extracting
        ? unpackTar({ cwd: staging, strip: 1, strict: true, preservePaths: false, preserveOwner: false, noMtime: true, maxDepth: 32, dmode: 0o700, fmode: 0o600, filter })
        : inspectTar({ strict: true, filter });
      await pipeline(file.createReadStream({ autoClose: false, start: 0 }), new Transform({ transform(chunk, encoding, callback) {
        compressed += chunk.length;
        if (compressed > size) { callback(new Error('Archive size mismatch')); return; }
        hash.update(chunk); callback(null, chunk);
      } }), createGunzip(), new Transform({ transform(chunk, encoding, callback) {
        expanded += chunk.length; callback(expanded > 1024 * 1024 * 1024 ? new Error('Archive expansion limit') : null, chunk);
      } }), parser);
      if (compressed !== size || hash.digest('hex') !== expectedDigest) throw new Error('Archive digest mismatch');
    }
  } finally { await file.close(); }
}
void unpack().then(() => process.exit(0), () => process.exit(1));
