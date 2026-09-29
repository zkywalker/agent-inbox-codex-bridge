#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const callsPath = path.join(directory, 'calls.json');
const calls = existsSync(callsPath) ? JSON.parse(readFileSync(callsPath, 'utf8')) : [];
calls.push(args);
writeFileSync(callsPath, JSON.stringify(calls));

if (args.length === 2 && args[0] === 'update' && args[1] === '--help') {
  process.stdout.write('Update Codex\nUsage: codex update [OPTIONS]\n');
} else if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('codex-cli 0.154.0\n');
} else if (args.length === 1 && args[0] === 'update') {
  const mode = existsSync(path.join(directory, 'mode')) ? readFileSync(path.join(directory, 'mode'), 'utf8') : '';
  if (mode === 'registry') {
    writeFileSync(path.join(directory, 'registry.json'), JSON.stringify({ lower: process.env.npm_config_registry, upper: process.env.NPM_CONFIG_REGISTRY }));
  }
  if (mode === 'descendant') {
    const heartbeat = path.join(directory, 'heartbeat');
    // The child ignores TERM and does not hold our output streams open. Merely
    // waiting for this wrapper to exit would leave installation writes running.
    spawn(process.execPath, ['-e', `const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),20);`], { stdio: 'ignore' });
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  }
} else {
  process.stderr.write('unexpected arguments');
  process.exitCode = 2;
}
