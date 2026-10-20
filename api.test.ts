import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApiUrl } from '../../frontend/src/services/api';

test('normaliza URLs para evitar o prefixo /api duplicado', () => {
  assert.equal(normalizeApiUrl('/api', '/api/users'), '/api/users');
  assert.equal(normalizeApiUrl('/api', '/api/auth/login'), '/api/auth/login');
  assert.equal(normalizeApiUrl('', '/api/users'), '/api/users');
  assert.equal(normalizeApiUrl('/v1', '/users'), '/v1/users');
  assert.equal(normalizeApiUrl('/api', 'https://example.com/api/users'), 'https://example.com/api/users');
});
