/** USD amount for display: `$` always, cents below $100, whole dollars from $100, `<$0.01` for tiny non-zero. */
export function formatMoney(usd: number): string {
  if (!Number.isFinite(usd)) return "—";
  const sign = usd < 0 ? "-" : "";
  const abs = Math.abs(usd);
  const cents = Math.round(abs * 100);
  if (abs === 0) return "$0.00";
  if (cents === 0) return usd < 0 ? "-<$0.01" : "<$0.01";
  if (cents >= 10_000)
    return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
  return `${sign}$${(cents / 100).toFixed(2)}`;
}
