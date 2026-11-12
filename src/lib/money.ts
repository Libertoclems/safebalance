// All money is handled in kobo (whole numbers). 1 naira = 100 kobo.

/** Largest amount allowed for one stage in the pilot: ₦20,000,000. */
export const MAX_STAGE_KOBO = 20_000_000 * 100;

/** Parse a naira amount typed by a person ("250,000" or "1500.50") into kobo. */
export function nairaToKobo(input: string | number): number {
  const text = String(input).replace(/[,₦\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new Error(`"${input}" is not a valid naira amount`);
  }
  const [whole, frac = ""] = text.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** Format kobo as naira for display: 25000000 -> "₦250,000". */
export function formatNaira(kobo: number): string {
  const sign = kobo < 0 ? "-" : "";
  const abs = Math.abs(kobo);
  const naira = Math.floor(abs / 100);
  const k = abs % 100;
  const whole = naira.toLocaleString("en-NG");
  return `${sign}₦${whole}${k ? "." + String(k).padStart(2, "0") : ""}`;
}

/**
 * Platform fee for one stage, paid by the client on top of the stage amount.
 * Pilot proposal from the spec (to be confirmed once partner costs are known):
 *   under ₦20,000            -> ₦100 flat
 *   ₦20,000 to ₦1,000,000    -> 1.5%
 *   over ₦1,000,000          -> 1.5%, capped at ₦15,000
 */
export function stageFee(amountKobo: number): number {
  if (amountKobo < 20_000 * 100) return 100 * 100;
  const pct = Math.round((amountKobo * 15) / 1000);
  if (amountKobo > 1_000_000 * 100) return Math.min(pct, 15_000 * 100);
  return pct;
}

/** Share of the fee earned when only part of a stage is paid to the worker. */
export function proRataFee(feeKobo: number, paidKobo: number, amountKobo: number): number {
  if (amountKobo === 0) return 0;
  return Math.round((feeKobo * paidKobo) / amountKobo);
}
