export type StockAlertType = 'low_stock' | 'out_of_stock' | null;

export function getStockAlertType(currentQty: number, previousQty: number, minQty: number): StockAlertType {
  const isNowZero = currentQty <= 0;
  const isNowAtOrBelowMin = currentQty <= minQty;
  const isReachingMinFromAbove = previousQty > currentQty && isNowAtOrBelowMin;
  const isMinRaisedAboveCurrent = previousQty === currentQty && isNowAtOrBelowMin && previousQty <= minQty;

  if (isNowZero && previousQty > 0) {
    return 'out_of_stock';
  }

  if (isNowAtOrBelowMin && (isReachingMinFromAbove || isMinRaisedAboveCurrent)) {
    return 'low_stock';
  }

  return null;
}
