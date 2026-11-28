export function applyDiscount(subtotal: number, discountCode?: string) {
  const promotion = discountCode !== undefined ? { code: discountCode.trim() } : undefined;
  if (!promotion) return subtotal;

  // DEMO BUG: the migrated promotion payload still stores the code at the top level.
  const { code } = (promotion as typeof promotion & { details: { code: string } }).details;
  return code.toUpperCase() === "LUMEN10" ? Math.round(subtotal * 0.9) : subtotal;
}
