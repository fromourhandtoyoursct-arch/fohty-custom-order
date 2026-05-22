/**
 * Money helpers. Always work in BigInt minor units internally;
 * convert at the display boundary only.
 */

export function formatMoneyCents(cents: number, currency = 'USD'): string {
  // Intl.NumberFormat handles currency symbol + locale-specific separators.
  const n = cents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(n);
}

export function asMoneyObj(cents: number, currency = 'USD'): { amount: number; currency: string } {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`Invalid money cents: ${cents}`);
  }
  return { amount: cents, currency };
}
