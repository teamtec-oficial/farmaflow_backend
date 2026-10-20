import test from 'node:test';
import assert from 'node:assert/strict';
import { getBusinessUnitSummary } from '../../frontend/src/lib/dashboard';

test('agrega estoque por unidade de negócio', () => {
  const businessUnits = [
    { id: 'matriz', name: 'Matriz', type: 'matriz' as const, code: 'MZ', active: true },
    { id: 'filial', name: 'Filial SP', type: 'filial' as const, code: 'SP', active: true },
  ];

  const epis = [
    { id: '1', currentQty: 10, minQty: 5, status: 'normal' as const, businessUnitId: 'matriz' },
    { id: '2', currentQty: 2, minQty: 5, status: 'low' as const, businessUnitId: 'matriz' },
    { id: '3', currentQty: 0, minQty: 5, status: 'out_of_stock' as const, businessUnitId: 'filial' },
  ];

  const summary = getBusinessUnitSummary(epis as any, businessUnits as any);

  assert.equal(summary[0].name, 'Matriz');
  assert.equal(summary[0].totalItemsInStock, 12);
  assert.equal(summary[0].lowStockCount, 1);
  assert.equal(summary[0].outOfStockCount, 0);
  assert.equal(summary[1].name, 'Filial SP');
  assert.equal(summary[1].totalItemsInStock, 0);
  assert.equal(summary[1].outOfStockCount, 1);
});
