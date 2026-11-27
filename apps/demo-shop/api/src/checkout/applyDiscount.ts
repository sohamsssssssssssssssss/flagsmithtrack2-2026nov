export function applyDiscount(subtotal: number, discountCode?: string) {
  const promotion = discountCode !== undefined ? { code: discountCode.trim() } : undefined;
  if (!promotion) return subtotal;

  // The promotion payload stores the code at the top level.
  const { code } = promotion;
  return code.toUpperCase() === "LUMEN10" ? Math.round(subtotal * 0.9) : subtotal;
}
