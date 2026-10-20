import test from 'node:test';
import assert from 'node:assert/strict';
import { canAccess, getApiAccessRequirement, isApiRoutePublic } from '../access-control.js';
import { normalizeAccessPolicy } from '../../frontend/src/lib/accessPolicy.js';
import { hashPassword, verifyPassword } from '../password-utils.js';

test('concede somente operações explicitamente informadas', () => {
  const permissions = { epis: ['view', 'create'] };

  assert.equal(canAccess('operador', permissions, { module: 'epis', operation: 'view' }), true);
  assert.equal(canAccess('operador', permissions, { module: 'epis', operation: 'delete' }), false);
  assert.equal(canAccess('admin', {}, { module: 'dashboard', operation: 'view' }), false);
  assert.equal(canAccess('master', {}, { module: 'dashboard', operation: 'view' }), true);
});

test('valida concessões e rejeita módulos ou operações desconhecidos', () => {
  assert.deepEqual(normalizeAccessPolicy({ 'formula-movements': ['view', 'create'] }), {
    'formula-movements': ['view', 'create'],
  });
  assert.equal(normalizeAccessPolicy({ unknown: ['view'] }), null);
  assert.equal(normalizeAccessPolicy({ epis: ['manage'] }), null);
});

test('mapeia endpoints protegidos para módulo e operação', () => {
  assert.deepEqual(getApiAccessRequirement('POST', '/api/epis'), { module: 'epis', operation: 'create' });
  assert.deepEqual(getApiAccessRequirement('DELETE', '/api/packagings/123'), { module: 'packagings', operation: 'delete' });
  assert.deepEqual(getApiAccessRequirement('GET', '/api/logs', { module: 'formula' }), {
    module: 'formula-audit',
    operation: 'view',
  });
  assert.equal(getApiAccessRequirement('GET', '/api/unmapped'), null);
  assert.equal(getApiAccessRequirement('GET', '/api/users')?.masterOnly, true);
});

test('mantém rotas de autenticação públicas e exige sessão para recursos', () => {
  assert.equal(isApiRoutePublic('POST', '/api/auth/login'), true);
  assert.equal(isApiRoutePublic('POST', '/api/auth/recover-password'), true);
  assert.equal(isApiRoutePublic('GET', '/api/epis'), false);
});

test('armazena senhas com hash e continua validando contas legadas', async () => {
  const password = 'uma senha segura com 12';
  const hash = await hashPassword(password);

  assert.match(hash, /^scrypt\$/);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword('senha incorreta', hash), false);
  assert.equal(await verifyPassword('senha legada', 'senha legada'), true);
});
