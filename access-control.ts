import type { AccessModule, AccessOperation } from '../frontend/src/lib/accessPolicy.js';
import { hasAccessPermission } from '../frontend/src/lib/accessPolicy.js';

export interface AccessRequirement {
  module: AccessModule;
  operation: AccessOperation;
  masterOnly?: boolean;
}

export function getApiAccessRequirement(
  method: string,
  path: string,
  query: Record<string, unknown> = {},
): AccessRequirement | null {
  const httpMethod = method.toUpperCase();

  if (path === '/api/users' || path.startsWith('/api/users/')) {
    return { module: 'system-audit', operation: 'view', masterOnly: true };
  }
  if (path === '/api/database-status' || path === '/api/reset-demo-data') {
    return { module: 'system-audit', operation: 'view', masterOnly: true };
  }
  if (path === '/api/business-units' || path.startsWith('/api/business-units/')) {
    const operation = httpMethod === 'GET' ? 'view' : httpMethod === 'POST' ? 'create' : httpMethod === 'DELETE' ? 'delete' : null;
    return operation ? { module: 'business-units', operation } : null;
  }
  if (path === '/api/packagings/audit') return { module: 'packaging-audit', operation: 'view' };
  if (path.startsWith('/api/packagings/movements')) {
    const operation = httpMethod === 'GET' ? 'view' : httpMethod === 'POST' ? 'create' : null;
    return operation ? { module: 'packaging-movements', operation } : null;
  }
  if (path === '/api/packagings' || path.startsWith('/api/packagings/')) {
    const operation = httpMethod === 'GET' ? 'view' : httpMethod === 'POST' ? 'create' : httpMethod === 'PUT' || httpMethod === 'PATCH' ? 'edit' : httpMethod === 'DELETE' ? 'delete' : null;
    return operation ? { module: 'packagings', operation } : null;
  }
  if (path.startsWith('/api/formulas-retiradas/movements')) {
    const operation = httpMethod === 'GET' ? 'view' : httpMethod === 'POST' ? 'create' : null;
    return operation ? { module: 'formula-movements', operation } : null;
  }
  if (path === '/api/formulas-retiradas' || path.startsWith('/api/formulas-retiradas/')) {
    const operation = httpMethod === 'GET' ? 'view' : httpMethod === 'POST' ? 'create' : httpMethod === 'PUT' || httpMethod === 'PATCH' ? 'edit' : httpMethod === 'DELETE' ? 'delete' : null;
    return operation ? { module: 'formulas', operation } : null;
  }
  if (path === '/api/epis' || path.startsWith('/api/epis/')) {
    const operation = httpMethod === 'GET' ? 'view' : httpMethod === 'POST' ? 'create' : httpMethod === 'PUT' || httpMethod === 'PATCH' ? 'edit' : httpMethod === 'DELETE' ? 'delete' : null;
    return operation ? { module: 'epis', operation } : null;
  }
  if (path === '/api/movements' || path.startsWith('/api/movements/')) {
    const operation = httpMethod === 'GET' ? 'view' : httpMethod === 'POST' ? 'create' : null;
    return operation ? { module: 'movements', operation } : null;
  }
  if (path === '/api/notifications' || path.startsWith('/api/notifications/')) {
    const operation = path.endsWith('/mark-read') ? 'manage' : httpMethod === 'GET' ? 'view' : null;
    return operation ? { module: 'notifications', operation } : null;
  }
  if (path === '/api/logs') {
    const module = String(query.module);
    const accessModule: AccessModule | null = module === 'epi' ? 'epi-audit'
      : module === 'formula' ? 'formula-audit'
      : module === 'system' ? 'system-audit'
      : null;
    return accessModule ? { module: accessModule, operation: 'view' } : null;
  }

  return null;
}

export function isApiRoutePublic(method: string, path: string): boolean {
  if (path === '/api/health') return true;
  if (path === '/api/auth/login' || path === '/api/auth/me' || path === '/api/auth/logout') return true;
  if (path === '/api/auth/recover-password' || path === '/api/auth/reset-password') return true;
  return false;
}

export function canAccess(
  role: string,
  permissions: unknown,
  requirement: AccessRequirement,
): boolean {
  if (role === 'master') return true;
  if (requirement.masterOnly) return false;
  return hasAccessPermission(permissions, requirement.module, requirement.operation);
}
