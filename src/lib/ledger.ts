import type { Db } from "./db";

// Double-entry ledger. Positive = debit, negative = credit.
// Every transaction must balance to zero, and every transaction has a unique
// reference so the same event can never be booked twice.

export const ACCOUNTS = {
  clearing: "partner:clearing",
  fees: "revenue:fees",
  suspense: "suspense",
  escrow: (stageId: string) => `escrow:stage:${stageId}`,
  userPayable: (userId: string) => `payable:user:${userId}`,
  supplierPayable: (stageId: string) => `payable:supplier:${stageId}`,
};

export type Entry = { account: string; amount: number };

export class LedgerError extends Error {}

export async function post(
  db: Db,
  tx: { reference: string; kind: string; memo?: string; stageId?: string; entries: Entry[] },
): Promise<{ created: boolean }> {
  const entries = tx.entries.filter((e) => e.amount !== 0);
  if (entries.length < 2) throw new LedgerError(`Transaction ${tx.reference} needs at least two entries`);
  for (const e of entries) {
    if (!Number.isInteger(e.amount)) throw new LedgerError(`Non-integer amount in ${tx.reference}`);
  }
  const sum = entries.reduce((s, e) => s + e.amount, 0);
  if (sum !== 0) throw new LedgerError(`Transaction ${tx.reference} does not balance (off by ${sum})`);

  const existing = await db.ledgerTransaction.findUnique({ where: { reference: tx.reference } });
  if (existing) return { created: false };

  await db.ledgerTransaction.create({
    data: {
      reference: tx.reference,
      kind: tx.kind,
      memo: tx.memo ?? "",
      stageId: tx.stageId,
      entries: { create: entries },
    },
  });
  return { created: true };
}

/** Balance of one account (debits minus credits). Liabilities come back negative. */
export async function balance(db: Db, account: string): Promise<number> {
  const rows = await db.ledgerEntry.findMany({ where: { account }, select: { amount: true } });
  return rows.reduce((s, r) => s + r.amount, 0);
}

/** Amount held for someone in a liability account, as a positive number. */
export async function held(db: Db, account: string): Promise<number> {
  return 0 - (await balance(db, account)); // "0 -" avoids -0 for empty accounts
}

/** Health check: every transaction balances and the whole ledger sums to zero. */
export async function checkLedger(db: Db) {
  const txs = await db.ledgerTransaction.findMany({ include: { entries: true } });
  const unbalanced = txs
    .filter((t) => t.entries.reduce((s, e) => s + e.amount, 0) !== 0)
    .map((t) => t.reference);
  const total = txs.reduce((s, t) => s + t.entries.reduce((a, e) => a + e.amount, 0), 0);

  const byAccount = new Map<string, number>();
  for (const t of txs) for (const e of t.entries) byAccount.set(e.account, (byAccount.get(e.account) ?? 0) + e.amount);

  return {
    ok: unbalanced.length === 0 && total === 0,
    transactions: txs.length,
    unbalanced,
    clearing: byAccount.get(ACCOUNTS.clearing) ?? 0,
    fees: 0 - (byAccount.get(ACCOUNTS.fees) ?? 0),
    suspense: 0 - (byAccount.get(ACCOUNTS.suspense) ?? 0),
    lockedInEscrow: 0 - [...byAccount].filter(([a]) => a.startsWith("escrow:")).reduce((s, [, v]) => s + v, 0),
    owedToUsers: 0 - [...byAccount].filter(([a]) => a.startsWith("payable:")).reduce((s, [, v]) => s + v, 0),
  };
}
