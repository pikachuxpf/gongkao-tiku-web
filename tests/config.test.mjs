import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.mjs';

test('production config requires an administrator password', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }, 'C:/mojuan'), /MOJUAN_ADMIN_PASSWORD/);
});

test('config exposes portable multi-user and unified AI settings', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    MOJUAN_ADMIN_PASSWORD: 'secure-password-123',
    MOJUAN_ADMIN_USERNAME: 'owner',
    MOJUAN_DB: 'C:/data/mojuan.sqlite',
    MOJUAN_ALLOW_REGISTRATION: 'false',
    MOJUAN_AI_ENDPOINT: 'https://example.com/v1/',
    MOJUAN_AI_MODEL: 'model-x',
    MOJUAN_AI_API_KEY: 'secret',
  }, 'C:/mojuan');
  assert.equal(config.admin.username, 'owner');
  assert.equal(config.dbPath, 'C:/data/mojuan.sqlite');
  assert.equal(config.allowRegistration, false);
  assert.equal(config.ai.endpoint, 'https://example.com/v1');
  assert.equal(config.ai.model, 'model-x');
});
