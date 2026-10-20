import test from 'node:test';
import assert from 'node:assert/strict';
import { getStockAlertType } from '../../frontend/src/lib/notifications.ts';

test('dispara alerta de estoque baixo quando o saldo cai para o mínimo', () => {
  assert.equal(getStockAlertType(5, 6, 5), 'low_stock');
});

test('dispara alerta de estoque baixo quando o mínimo é ajustado acima do saldo atual', () => {
  assert.equal(getStockAlertType(3, 3, 5), 'low_stock');
});

test('dispara alerta de esgotamento quando o saldo chega a zero', () => {
  assert.equal(getStockAlertType(0, 3, 5), 'out_of_stock');
});

test('não dispara alerta quando o saldo continua acima do mínimo', () => {
  assert.equal(getStockAlertType(8, 7, 5), null);
});
