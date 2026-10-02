import { readFile, writeFile } from 'node:fs/promises';
import { configContract } from '../dist/src/config.js';

const expected = `${JSON.stringify(configContract, null, 2)}\n`;
const file = new URL('../config-contract.json', import.meta.url);
if (process.argv.includes('--check')) {
  if (await readFile(file, 'utf8') !== expected) throw new Error('Configuration contract differs from compiled validator');
} else await writeFile(file, expected);
