import { prisma } from "./db";
import { ACCOUNTS, held, post } from "./ledger";
import { getProvider } from "./payments";

// Money owed to someone sits in a payable account until it is paid out.
// A payout is booked in the ledger before the partner is asked to send it;
// if the partner reports failure, the booking is reversed so it can be retried.
//
// On Vercel many copies of the app run at once, so two payouts for the same
// account could race. A Postgres advisory lock, held for the length of the
// booking transaction, makes them take turns across every copy: the second
// one then sees a zero balance and pays nothing.

type Recipient = { userId?: string; stageId?: string; name: string; bankName: string; accountNumber: string };

async function payOut(account: string, to: Recipient) {
  {
    const booked = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${account}))::text`;
      const amount = await held(tx, account);
      if (amount <= 0) return null;
      const p = await tx.payout.create({
        data: {
          userId: to.userId, stageId: to.stageId, payable: account, recipientName: to.name,
          bankName: to.bankName, accountNumber: to.accountNumber, amount,
        },
      });
      await post(tx, {
        reference: `payout:${p.id}`,
        kind: "PAYOUT",
        stageId: to.stageId,
        memo: `Payout to ${to.name}`,
        entries: [
          { account, amount },
          { account: ACCOUNTS.clearing, amount: -amount },
        ],
      });
      return p;
    });
    if (!booked) return null;
    const payout = booked;
    const amount = booked.amount;

    let result: { status: "SUCCESS" | "PENDING" | "FAILED"; providerRef: string };
    try {
      result = await getProvider().sendPayout({
        reference: payout.id, amountKobo: amount, bankName: to.bankName,
        accountNumber: to.accountNumber, accountName: to.name,
      });
    } catch {
      result = { status: "FAILED", providerRef: "" };
    }

    await prisma.$transaction(async (tx) => {
      await tx.payout.update({ where: { id: payout.id }, data: { status: result.status, providerRef: result.providerRef } });
      if (result.status === "FAILED") {
        await post(tx, {
          reference: `payout-reversal:${payout.id}`,
          kind: "PAYOUT_REVERSAL",
          stageId: to.stageId,
          memo: "Partner could not send the payout; money returned to payable",
          entries: [
            { account: ACCOUNTS.clearing, amount },
            { account, amount: -amount },
          ],
        });
      }
    });
    return { ...payout, status: result.status };
  }
}

/** Pay a user everything they are owed, if they have saved bank details. */
export async function settleUser(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.bankAccountNumber || !user.bankName || !user.idVerified) return null;
  return payOut(ACCOUNTS.userPayable(userId), {
    userId, name: user.bankAccountName || user.name, bankName: user.bankName, accountNumber: user.bankAccountNumber,
  });
}

/** Pay a materials supplier straight from their stage. */
export async function settleSupplier(stageId: string) {
  const stage = await prisma.stage.findUnique({ where: { id: stageId } });
  if (!stage?.supplierAcct || !stage.supplierBank) return null;
  return payOut(ACCOUNTS.supplierPayable(stageId), {
    stageId, name: stage.supplierName ?? "Supplier", bankName: stage.supplierBank, accountNumber: stage.supplierAcct,
  });
}

/** Try to pay everyone on a deal who is owed money. */
export async function settleDeal(dealId: string) {
  const deal = await prisma.deal.findUnique({ where: { id: dealId }, include: { stages: true } });
  if (!deal) return;
  await settleUser(deal.workerId);
  if (deal.clientId) await settleUser(deal.clientId);
  for (const s of deal.stages) if (s.kind === "MATERIALS" && s.supplierAcct) await settleSupplier(s.id);
}
