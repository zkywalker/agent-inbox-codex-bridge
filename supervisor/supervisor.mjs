#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(process.env.AGENT_INBOX_BRIDGE_ROOT || process.argv[2] || '');
const config = resolve(process.env.AGENT_INBOX_BRIDGE_CONFIG || process.argv[3] || '');
if (!root || !config) throw new Error('Usage: supervisor.mjs <private-root> <private-config.json>');

const current = join(root, 'current');
const state = join(root, 'state');
mkdirSync(state, { recursive: true, mode: 0o700 });
let stopping = false;
let child;

function entrypoint() {
  const path = join(current, 'dist', 'src', 'main.js');
  if (!existsSync(path)) throw new Error(`Bridge bundle is missing: ${path}`);
  return path;
}

function start() {
  child = spawn(process.execPath, [entrypoint(), config], { stdio: 'inherit', env: process.env });
  child.once('exit', (code, signal) => {
    if (stopping) process.exit(code ?? 0);
    if (code === 0) setTimeout(start, 1000);
    else setTimeout(start, 5000);
    console.error(`[bridge-supervisor] bridge exited (${code ?? signal}); restarting`);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  stopping = true;
  child?.kill(signal);
});

start();
