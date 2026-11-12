import { prisma } from "./db";
import { addPeriod, DealError, dealUrl, prepareFunding, SAVING_STAGE } from "./deals";
import { ACCOUNTS, held } from "./ledger";
import { formatNaira } from "./money";

// "Pay small small": a client who doesn't have a stage's full amount yet can
// pay it in parts. Any transfer to the stage's account counts (see
// recordIncomingTransfer); a plan only sets a schedule and reminders.
// Saved money is simply locked. It never earns interest or returns.

export const EVERY = {
  WEEK: "every week",
  TWO_WEEKS: "every 2 weeks",
  MONTH: "every month",
} as const;
export type Every = keyof typeof EVERY;

const lagosDate = (d: Date) => d.toLocaleDateString("en-NG", { weekday: "short", day: "numeric", month: "short", timeZone: "Africa/Lagos" });

/** How much is saved and still to pay for a stage (includes the fee the client pays). */
export async function savingProgress(stageId: string) {
  const stage = await prisma.stage.findUniqueOrThrow({ where: { id: stageId }, include: { plan: true } });
  const target = stage.amount + stage.fee;
  const saved = await held(prisma, ACCOUNTS.escrow(stageId));
  const remaining = Math.max(0, target - saved);
  const plan = stage.plan?.active ? stage.plan : null;
  return {
    target,
    saved,
    remaining,
    percent: target ? Math.floor((Math.min(saved, target) / target) * 100) : 0,
    plan,
    nextAmount: plan ? Math.min(plan.instalment, remaining) : remaining,
  };
}

/**
 * Money locked on a deal right now, as the worker's share: paid stages count
 * in full, stages being paid in parts count what's saved so far.
 */
export async function lockedNow(stages: { id: string; status: string; amount: number }[]) {
  let total = 0;
  for (const s of stages) {
    if (["FUNDED", "IN_REVIEW", "DISPUTED"].includes(s.status)) total += s.amount;
    else if (s.status === "PARTLY_FUNDED") total += Math.min(s.amount, await held(prisma, ACCOUNTS.escrow(s.id)));
  }
  return total;
}

/** Client picks how many parts and how often. The first part is due now. */
export async function setPlan(stageId: string, clientId: string, parts: number, every: string) {
  if (!Number.isInteger(parts) || parts < 2 || parts > 12) throw new DealError("Choose between 2 and 12 parts");
  if (!(every in EVERY)) throw new DealError("Choose how often you'll pay");
  const stage = await prepareFunding(stageId, clientId); // checks client, order, and creates the account
  const { remaining } = await savingProgress(stageId);
  if (remaining < parts * 100_00) throw new DealError("The amount left is too small to split into that many parts");
  const instalment = Math.ceil(remaining / parts / 100) * 100; // whole naira

  const now = new Date();
  const data = { parts, instalment, every, nextDueAt: now, lastReminderAt: now, active: true };
  await prisma.instalmentPlan.upsert({ where: { stageId }, update: data, create: { stageId, ...data } });
  return { stage, instalment, parts, every: every as Every };
}

export async function cancelPlan(stageId: string, clientId: string) {
  const stage = await prisma.stage.findUnique({ where: { id: stageId }, include: { deal: true } });
  if (!stage || stage.deal.clientId !== clientId) throw new DealError("Only the client can change the payment plan");
  await prisma.instalmentPlan.updateMany({ where: { stageId }, data: { active: false } });
}

/** The schedule as dates, for showing to the client. */
export function schedule(plan: { instalment: number; every: string; nextDueAt: Date }, remaining: number) {
  const rows: { due: Date; amount: number }[] = [];
  let left = remaining;
  let due = plan.nextDueAt;
  while (left > 0 && rows.length < 12) {
    const amount = Math.min(plan.instalment, left);
    rows.push({ due, amount });
    left -= amount;
    due = addPeriod(due, plan.every);
  }
  return rows;
}

/**
 * Run by the background worker. Sends a WhatsApp reminder the day before an
 * instalment is due, and one gentle nudge if it's 3 days late.
 */
export async function sendInstalmentReminders(now = new Date()) {
  const plans = await prisma.instalmentPlan.findMany({
    where: { active: true, stage: { status: { in: SAVING_STAGE }, deal: { status: "ACTIVE" } } },
    include: { stage: { include: { deal: true } } },
  });
  let sent = 0;
  for (const p of plans) {
    const dayBefore = new Date(p.nextDueAt.getTime() - 24 * 3600_000);
    const lateBy3 = new Date(p.nextDueAt.getTime() + 3 * 24 * 3600_000);
    const upcoming = now >= dayBefore && now < p.nextDueAt && (!p.lastReminderAt || p.lastReminderAt < dayBefore);
    const overdue = now >= lateBy3 && (!p.lastReminderAt || p.lastReminderAt < lateBy3);
    if (!upcoming && !overdue) continue;

    const { remaining, saved, target } = await savingProgress(p.stageId);
    const s = p.stage;
    const clientId = s.deal.clientId;
    if (remaining <= 0 || !clientId) continue;
    const amount = Math.min(p.instalment, remaining);
    const text =
      `*${s.deal.title}*\n` +
      (overdue
        ? `Your part payment of ${formatNaira(amount)} for "${s.title}" was due ${lagosDate(p.nextDueAt)}. Pay when you can; the work starts once it's fully paid.`
        : `Reminder: your next part payment for "${s.title}" is due ${lagosDate(p.nextDueAt)}: ${formatNaira(amount)}.`) +
      `\nPay to ${s.accountBank} ${s.accountNumber}.\nSaved so far: ${formatNaira(saved)} of ${formatNaira(target)}.\n\n${dealUrl(s.deal.code)}`;

    // Mark first, so a crash can't send the same reminder twice.
    const r = await prisma.instalmentPlan.updateMany({
      where: { id: p.id, lastReminderAt: p.lastReminderAt },
      data: { lastReminderAt: now },
    });
    if (r.count !== 1) continue;
    await prisma.notification.create({
      data: {
        userId: clientId,
        dealId: s.dealId,
        text,
        buttons: JSON.stringify([{ id: `pay:${s.id}`, title: "Payment details" }]),
      },
    });
    sent++;
  }
  return sent;
}
