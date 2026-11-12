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
 * Platform fee: a straight percentage of every stage, paid by the client on
 * top of the stage amount, so fee income grows with volume. No minimum, no cap.
 * Change the rate here; it's used everywhere (deal form, WhatsApp, ledger).
 * The fee is fixed on each stage when the deal is created, so changing the
 * rate only affects new deals.
 */
export const FEE_RATE_PERCENT = 5;

export function stageFee(amountKobo: number): number {
  return Math.round((amountKobo * FEE_RATE_PERCENT) / 100);
}

/** Share of the fee earned when only part of a stage is paid to the worker. */
export function proRataFee(feeKobo: number, paidKobo: number, amountKobo: number): number {
  if (amountKobo === 0) return 0;
  return Math.round((feeKobo * paidKobo) / amountKobo);
}
