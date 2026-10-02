import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBridgeConfig, configContract } from '../dist/src/config.js';

const config = { gatewayUrl: 'https://inbox.example', token: 'fixture-message-token-only', managementToken: 'fixture-management-token-only', codexBinary: process.execPath, stateDir: '/tmp/state', projects: [{ id: 'project', name: 'Project', path: '/tmp' }] };

test('mirror configuration is host-only opt-in and is published in the validation contract', () => {
  const nativeUpdateRegistry = 'https://npm-mirror.example/registry/';
  const parsed = parseBridgeConfig({ ...config, nativeUpdateRegistry });
  assert.equal(parsed.nativeUpdateRegistry, nativeUpdateRegistry);
  assert.equal(parsed.allowNativeUpdate, undefined);
  assert.equal(configContract.schema.properties.nativeUpdateRegistry.format, 'uri');
  for (const value of ['', 'http://npm-mirror.example/', 'https://user:secret@npm-mirror.example/', 'https://npm-mirror.example/?token=secret', 'https://npm-mirror.example/#fragment']) {
    assert.throws(() => parseBridgeConfig({ ...config, nativeUpdateRegistry: value }));
  }
});
