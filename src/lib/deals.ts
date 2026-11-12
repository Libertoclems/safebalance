import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma, type Db } from "./db";
import { ACCOUNTS, held, post } from "./ledger";
import { MAX_STAGE_KOBO, formatNaira, proRataFee, stageFee } from "./money";
import { getProvider, isTestMode } from "./payments";
import type { IncomingTransfer } from "./payments/types";
import { settleDeal } from "./payouts";

/** An error whose message is safe and useful to show to the person. */
export class DealError extends Error {}

const CLOSED_STAGE = ["RELEASED", "REFUNDED", "SPLIT", "CANCELLED"];
const LOCKED_STAGE = ["FUNDED", "IN_REVIEW", "DISPUTED"];
/** Stages still taking payment: nothing yet, or part of it ("pay small small"). */
export const SAVING_STAGE = ["UNFUNDED", "PARTLY_FUNDED"];

/** Next due date for an instalment plan. */
export function addPeriod(d: Date, every: string) {
  const next = new Date(d);
  if (every === "MONTH") next.setMonth(next.getMonth() + 1);
  else next.setDate(next.getDate() + (every === "TWO_WEEKS" ? 14 : 7));
  return next;
}
const MIN_STAGE_KOBO = 500 * 100;

// ---------- helpers ----------

function newCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

// Events the people on a deal are told about (WhatsApp now, SMS later).
// By default everyone except the person who acted is told; these go to both sides.
const NOTIFY_EVERYONE = new Set([
  "STAGE_FUNDED", "INSTALMENT_RECEIVED", "STAGE_RELEASED", "DISPUTE_RESOLVED", "DEAL_COMPLETED", "PAYMENT_MISMATCH",
]);
const NO_NOTIFY = new Set(["DEAL_CREATED"]);

export function dealUrl(code: string) {
  return `${process.env.APP_URL ?? "http://localhost:3000"}/d/${code}`;
}

type Btn = { id: string; title: string };

/** Write to the deal's history and queue notifications in the same transaction. */
export async function logDealEvent(...args: Parameters<typeof log>) {
  return log(...args);
}

async function log(
  db: Db,
  dealId: string,
  actorId: string | null,
  type: string,
  message: string,
  opts: { stageId?: string; buttons?: { worker?: Btn[]; client?: Btn[] } } = {},
) {
  await db.dealEvent.create({ data: { dealId, actorId, type, message } });
  if (NO_NOTIFY.has(type)) return;

  const deal = await db.deal.findUnique({ where: { id: dealId } });
  if (!deal) return;
  const parties = [deal.workerId, deal.clientId].filter((id): id is string => !!id);
  const recipients = NOTIFY_EVERYONE.has(type) ? parties : parties.filter((id) => id !== actorId);
  const text = `*${deal.title}*\n${message}\n\n${dealUrl(deal.code)}`;

  for (const userId of recipients) {
    const custom = userId === deal.workerId ? opts.buttons?.worker : opts.buttons?.client;
    const buttons =
      custom ??
      (type === "PROOF_SUBMITTED" && userId === deal.clientId && opts.stageId
        ? [{ id: `approve:${opts.stageId}`, title: "Approve & pay" }, { id: `issue:${opts.stageId}`, title: "Raise an issue" }]
        : [{ id: `deal:${dealId}`, title: "View deal" }]);
    await db.notification.create({ data: { userId, dealId, text, buttons: JSON.stringify(buttons) } });
  }
}

/** Move a stage only if it is still in an expected status, so two clicks can't pay twice. */
async function moveStage(db: Db, stageId: string, from: string[], data: Prisma.StageUpdateManyMutationInput) {
  const r = await db.stage.updateMany({ where: { id: stageId, status: { in: from } }, data });
  if (r.count !== 1) throw new DealError("This stage has already changed. Refresh the page and try again.");
}

async function loadStage(db: Db, stageId: string) {
  const stage = await db.stage.findUnique({ where: { id: stageId }, include: { deal: true } });
  if (!stage) throw new DealError("Stage not found");
  return stage;
}

async function maybeComplete(db: Db, dealId: string) {
  const stages = await db.stage.findMany({ where: { dealId } });
  const allClosed = stages.every((s) => CLOSED_STAGE.includes(s.status));
  const anyPaid = stages.some((s) => s.status !== "CANCELLED");
  if (allClosed && anyPaid) {
    const r = await db.deal.updateMany({ where: { id: dealId, status: "ACTIVE" }, data: { status: "COMPLETED" } });
    if (r.count) await log(db, dealId, null, "DEAL_COMPLETED", "All stages are closed. The deal is complete.");
  }
}

/** Pay out a locked stage in full: amount to the worker (or supplier), fee to us. */
async function releaseInTx(db: Db, stageId: string, actorId: string | null, why: string) {
  const stage = await loadStage(db, stageId);
  await moveStage(db, stageId, ["FUNDED", "IN_REVIEW"], { status: "RELEASED", closedAt: new Date() });
  const payee =
    stage.kind === "MATERIALS" && stage.supplierAcct
      ? ACCOUNTS.supplierPayable(stage.id)
      : ACCOUNTS.userPayable(stage.deal.workerId);
  await post(db, {
    reference: `release:${stage.id}`,
    kind: "RELEASE",
    stageId: stage.id,
    memo: why,
    entries: [
      { account: ACCOUNTS.escrow(stage.id), amount: stage.amount + stage.fee },
      { account: payee, amount: -stage.amount },
      { account: ACCOUNTS.fees, amount: -stage.fee },
    ],
  });
  const to = payee.startsWith("payable:supplier") ? stage.supplierName ?? "the supplier" : "the worker";
  await log(db, stage.dealId, actorId, "STAGE_RELEASED", `"${stage.title}": ${formatNaira(stage.amount)} released to ${to}. ${why}`);
  await maybeComplete(db, stage.dealId);
}

// ---------- creating and accepting deals ----------

export type NewStage = {
  title: string;
  amountKobo: number;
  kind?: "WORK" | "MATERIALS";
  supplierName?: string;
  supplierBank?: string;
  supplierAcct?: string;
};

function checkStage(s: NewStage) {
  if (!s.title.trim()) throw new DealError("Every stage needs a name");
  if (!Number.isInteger(s.amountKobo) || s.amountKobo < MIN_STAGE_KOBO)
    throw new DealError(`Each stage must be at least ${formatNaira(MIN_STAGE_KOBO)}`);
  if (s.amountKobo > MAX_STAGE_KOBO) throw new DealError(`A stage can't be more than ${formatNaira(MAX_STAGE_KOBO)} in the pilot`);
  if (s.supplierAcct && !/^\d{10}$/.test(s.supplierAcct)) throw new DealError("Supplier account number must be 10 digits");
}

export async function createDeal(
  workerId: string,
  input: { title: string; description?: string; reviewHours?: number; stages: NewStage[] },
) {
  if (!input.title.trim()) throw new DealError("Give the job a title");
  if (input.stages.length < 1 || input.stages.length > 10) throw new DealError("A deal needs between 1 and 10 stages");
  input.stages.forEach(checkStage);
  const reviewHours = input.reviewHours ?? 72;
  if (reviewHours < 24 || reviewHours > 168) throw new DealError("The review window must be between 24 and 168 hours");

  return prisma.$transaction(async (tx) => {
    const deal = await tx.deal.create({
      data: {
        code: newCode(),
        title: input.title.trim(),
        description: (input.description ?? "").trim(),
        reviewHours,
        workerId,
        stages: {
          create: input.stages.map((s, i) => ({
            position: i + 1,
            title: s.title.trim(),
            amount: s.amountKobo,
            fee: stageFee(s.amountKobo),
            kind: s.kind ?? "WORK",
            supplierName: s.kind === "MATERIALS" ? s.supplierName?.trim() || null : null,
            supplierBank: s.kind === "MATERIALS" ? s.supplierBank?.trim() || null : null,
            supplierAcct: s.kind === "MATERIALS" ? s.supplierAcct?.trim() || null : null,
          })),
        },
      },
    });
    await log(tx, deal.id, workerId, "DEAL_CREATED", `Deal created with ${input.stages.length} stage(s).`);
    return deal;
  });
}

export async function acceptDeal(dealId: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    const deal = await tx.deal.findUnique({ where: { id: dealId } });
    if (!deal) throw new DealError("Deal not found");
    if (deal.workerId === userId) throw new DealError("You created this deal. Share the link with your client.");
    const r = await tx.deal.updateMany({
      where: { id: dealId, status: "AWAITING_CLIENT", clientId: null },
      data: { clientId: userId, status: "ACTIVE", acceptedAt: new Date() },
    });
    if (r.count !== 1) throw new DealError("This deal has already been accepted");
    await log(tx, dealId, userId, "DEAL_ACCEPTED", "Client accepted the terms.");
  });
}

// ---------- funding ----------

/** Give the client an account number for the next stage to fund. */
export async function prepareFunding(stageId: string, userId: string) {
  const stage = await loadStage(prisma, stageId);
  if (stage.deal.clientId !== userId) throw new DealError("Only the client can fund this deal");
  if (stage.deal.status !== "ACTIVE") throw new DealError("This deal is not active");
  if (!SAVING_STAGE.includes(stage.status)) throw new DealError("This stage is not waiting for payment");

  const earlier = await prisma.stage.count({
    where: { dealId: stage.dealId, position: { lt: stage.position }, status: { in: SAVING_STAGE } },
  });
  if (earlier > 0) throw new DealError("Fund the earlier stages first");

  if (stage.paymentRef && stage.accountNumber) return stage;

  const reference = `stg_${stage.id}`;
  const va = await getProvider().createVirtualAccount({
    reference,
    amountKobo: stage.amount + stage.fee,
    customerName: stage.deal.title,
  });
  return prisma.stage.update({
    where: { id: stage.id },
    data: { paymentRef: va.reference, accountNumber: va.accountNumber, accountBank: va.bankName },
  });
}

/**
 * Book a transfer reported by the payment partner. Safe to call more than once
 * with the same event: repeats are ignored.
 *
 * "Pay small small": a stage can be paid in any number of transfers. Each one
 * adds to the stage's locked balance; when it reaches the full amount the
 * stage is funded and the worker can start. Anything sent beyond what's
 * needed is refunded to the client. A transfer for a stage that isn't taking
 * payment (or an unknown reference) goes to suspense for an admin.
 */
export async function recordIncomingTransfer(provider: string, t: IncomingTransfer, rawPayload: string) {
  const result = await prisma.$transaction(async (tx) => {
    try {
      await tx.webhookEvent.create({ data: { provider, eventId: t.eventId, payload: rawPayload } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { outcome: "duplicate" as const };
      throw e;
    }

    const stage = await tx.stage.findUnique({ where: { paymentRef: t.reference }, include: { deal: true, plan: true } });
    const expected = stage ? stage.amount + stage.fee : 0;
    const takingPayment = !!stage && SAVING_STAGE.includes(stage.status) && stage.deal.status === "ACTIVE" && !!stage.deal.clientId;

    if (!stage || !takingPayment || t.amountKobo <= 0) {
      await post(tx, {
        reference: `in:${provider}:${t.eventId}`,
        kind: "UNMATCHED_TRANSFER",
        stageId: stage?.id,
        memo: `Transfer of ${formatNaira(t.amountKobo)} for ref ${t.reference} did not match a stage`,
        entries: [
          { account: ACCOUNTS.clearing, amount: t.amountKobo },
          { account: ACCOUNTS.suspense, amount: -t.amountKobo },
        ],
      });
      if (stage) {
        await log(tx, stage.dealId, null, "PAYMENT_MISMATCH",
          `A transfer of ${formatNaira(t.amountKobo)} arrived for "${stage.title}", which isn't taking payment any more. Our team will refund it.`);
      }
      return { outcome: "suspense" as const, dealId: stage?.dealId };
    }

    const saved = await held(tx, ACCOUNTS.escrow(stage.id));
    const applied = Math.min(t.amountKobo, expected - saved);
    const excess = t.amountKobo - applied;
    await post(tx, {
      reference: `in:${provider}:${t.eventId}`,
      kind: "FUNDING",
      stageId: stage.id,
      memo: `Client paid ${formatNaira(t.amountKobo)} towards "${stage.title}"`,
      entries: [
        { account: ACCOUNTS.clearing, amount: t.amountKobo },
        { account: ACCOUNTS.escrow(stage.id), amount: -applied },
        { account: ACCOUNTS.userPayable(stage.deal.clientId!), amount: -excess }, // overpayment goes back
      ],
    });
    const nowSaved = saved + applied;
    const refundNote = excess > 0 ? ` ${formatNaira(excess)} more than needed was sent and is being refunded.` : "";

    if (nowSaved >= expected) {
      await moveStage(tx, stage.id, SAVING_STAGE, { status: "FUNDED", fundedAt: new Date() });
      if (stage.plan) await tx.instalmentPlan.update({ where: { id: stage.plan.id }, data: { active: false } });
      await log(tx, stage.dealId, stage.deal.clientId, "STAGE_FUNDED",
        `"${stage.title}" funded: ${formatNaira(stage.amount)} is locked. The worker can start.${refundNote}`);
      if (stage.kind === "MATERIALS") {
        await releaseInTx(tx, stage.id, null, "Materials money is released as soon as it is funded.");
      }
      return { outcome: "funded" as const, dealId: stage.dealId };
    }

    // Part payment: keep saving. The worker is told not to start yet.
    await moveStage(tx, stage.id, SAVING_STAGE, { status: "PARTLY_FUNDED" });
    if (stage.plan?.active) {
      const now = new Date();
      // This payment covers the instalment that was due; move to the next date.
      const next = stage.plan.nextDueAt <= addPeriod(now, stage.plan.every) ? addPeriod(stage.plan.nextDueAt, stage.plan.every) : stage.plan.nextDueAt;
      await tx.instalmentPlan.update({ where: { id: stage.plan.id }, data: { nextDueAt: next, lastReminderAt: null } });
    }
    const pct = Math.floor((nowSaved / expected) * 100);
    await log(tx, stage.dealId, stage.deal.clientId, "INSTALMENT_RECEIVED",
      `Part payment of ${formatNaira(applied)} received for "${stage.title}". Saved so far: ${formatNaira(nowSaved)} of ${formatNaira(expected)} (${pct}%), ` +
        `${formatNaira(expected - nowSaved)} to go. The money is locked, and work on this stage starts once it's fully paid.${refundNote}`);
    return { outcome: "partial" as const, dealId: stage.dealId };
  });

  if (result.outcome !== "duplicate" && result.dealId) await settleDeal(result.dealId);
  return result;
}

// ---------- doing the work ----------

export async function submitProof(
  stageId: string,
  workerId: string,
  proof: { filePath: string; mimeType: string; note?: string; lat?: number | null; lng?: number | null },
) {
  return prisma.$transaction(async (tx) => {
    const stage = await loadStage(tx, stageId);
    if (stage.deal.workerId !== workerId) throw new DealError("Only the worker can upload proof");
    if (!["FUNDED", "IN_REVIEW"].includes(stage.status)) throw new DealError("Proof can only be added to a funded stage");

    await tx.proof.create({
      data: { stageId, filePath: proof.filePath, mimeType: proof.mimeType, note: proof.note ?? "", lat: proof.lat, lng: proof.lng },
    });

    if (stage.status === "FUNDED") {
      const deadline = new Date(Date.now() + stage.deal.reviewHours * 3600_000);
      await moveStage(tx, stageId, ["FUNDED"], { status: "IN_REVIEW", submittedAt: new Date(), reviewDeadline: deadline });
      await log(tx, stage.dealId, workerId, "PROOF_SUBMITTED",
        `Proof submitted for "${stage.title}". The client has ${stage.deal.reviewHours} hours to approve or raise an issue; after that, payment releases automatically.`,
        { stageId });
    } else {
      await log(tx, stage.dealId, workerId, "PROOF_ADDED", `More proof added for "${stage.title}".`);
    }
  });
}

export async function approveStage(stageId: string, clientId: string) {
  const dealId = await prisma.$transaction(async (tx) => {
    const stage = await loadStage(tx, stageId);
    if (stage.deal.clientId !== clientId) throw new DealError("Only the client can approve");
    if (stage.status !== "IN_REVIEW") throw new DealError("This stage is not waiting for approval");
    await releaseInTx(tx, stageId, clientId, "Approved by the client.");
    return stage.dealId;
  });
  await settleDeal(dealId);
}

/** Release every stage whose review window has passed. Run on a timer. */
export async function autoReleaseDue(now = new Date()) {
  const due = await prisma.stage.findMany({
    where: { status: "IN_REVIEW", reviewDeadline: { lte: now } },
    select: { id: true, dealId: true },
  });
  let released = 0;
  for (const s of due) {
    try {
      await prisma.$transaction((tx) =>
        releaseInTx(tx, s.id, null, "The client did not respond within the review window, so payment was released automatically."),
      );
      released++;
      await settleDeal(s.dealId);
    } catch (e) {
      if (!(e instanceof DealError)) throw e; // already moved by someone else
    }
  }
  return released;
}

/** Test mode only: end a review window now so auto-release can be tried. */
export async function fastForwardReview(stageId: string) {
  if (!isTestMode()) throw new DealError("Only available in test mode");
  await prisma.stage.updateMany({
    where: { id: stageId, status: "IN_REVIEW" },
    data: { reviewDeadline: new Date(Date.now() - 1000) },
  });
  return autoReleaseDue();
}

// ---------- disputes ----------

export async function raiseDispute(stageId: string, clientId: string, reason: string) {
  if (reason.trim().length < 10) throw new DealError("Explain the problem in a sentence or two");
  return prisma.$transaction(async (tx) => {
    const stage = await loadStage(tx, stageId);
    if (stage.deal.clientId !== clientId) throw new DealError("Only the client can raise an issue");
    await moveStage(tx, stageId, ["FUNDED", "IN_REVIEW"], { status: "DISPUTED", reviewDeadline: null });
    const dispute = await tx.dispute.create({
      data: {
        stageId,
        raisedById: clientId,
        reason: reason.trim(),
        responseDeadline: new Date(Date.now() + RESPONSE_HOURS * 3600_000),
        statements: { create: { userId: clientId, role: "CLIENT", text: reason.trim() } },
      },
    });
    await log(tx, stage.dealId, clientId, "DISPUTE_RAISED",
      `Client raised an issue on "${stage.title}": "${reason.trim().slice(0, 300)}"\n\nThe money stays locked until it is settled. ` +
        `Worker: give your side within ${RESPONSE_HOURS} hours, then a mediator will suggest a fair outcome.`,
      { buttons: { worker: [{ id: `respond:${dispute.id}`, title: "Give my side" }] } });
    return dispute;
  });
}

/** Hours the worker has to give their side before mediation starts anyway. */
export const RESPONSE_HOURS = 48;

/** Admin decision: how much of the stage goes to the worker; the rest goes back to the client. */
export async function resolveDispute(disputeId: string, adminId: string, workerShareKobo: number, note: string) {
  const dealId = await prisma.$transaction(async (tx) => {
    const dispute = await tx.dispute.findUnique({ where: { id: disputeId } });
    if (!dispute || dispute.status !== "OPEN") throw new DealError("This dispute is not open");
    const stage = await loadStage(tx, dispute.stageId);
    if (!stage.deal.clientId) throw new DealError("Deal has no client");
    if (!Number.isInteger(workerShareKobo) || workerShareKobo < 0 || workerShareKobo > stage.amount)
      throw new DealError(`The worker's share must be between ₦0 and ${formatNaira(stage.amount)}`);

    const feeEarned = proRataFee(stage.fee, workerShareKobo, stage.amount);
    const refund = stage.amount + stage.fee - workerShareKobo - feeEarned;
    const status = workerShareKobo === stage.amount ? "RELEASED" : workerShareKobo === 0 ? "REFUNDED" : "SPLIT";

    await moveStage(tx, stage.id, ["DISPUTED"], { status, closedAt: new Date() });
    await post(tx, {
      reference: `resolve:${stage.id}`,
      kind: "DISPUTE_SETTLEMENT",
      stageId: stage.id,
      memo: note,
      entries: [
        { account: ACCOUNTS.escrow(stage.id), amount: stage.amount + stage.fee },
        { account: ACCOUNTS.userPayable(stage.deal.workerId), amount: -workerShareKobo },
        { account: ACCOUNTS.fees, amount: -feeEarned },
        { account: ACCOUNTS.userPayable(stage.deal.clientId), amount: -refund },
      ],
    });
    await tx.dispute.update({
      where: { id: disputeId },
      data: { status: "RESOLVED", workerShare: workerShareKobo, resolutionNote: note, resolvedById: adminId, resolvedAt: new Date() },
    });
    await log(tx, stage.dealId, adminId, "DISPUTE_RESOLVED",
      `Issue on "${stage.title}" settled: ${formatNaira(workerShareKobo)} to the worker, ${formatNaira(refund)} back to the client. ${note}`);
    await maybeComplete(tx, stage.dealId);
    return stage.dealId;
  });
  await settleDeal(dealId);
}

// ---------- change orders and cancelling ----------

export async function addChangeOrder(dealId: string, workerId: string, s: NewStage) {
  checkStage({ ...s, kind: "WORK" });
  return prisma.$transaction(async (tx) => {
    const deal = await tx.deal.findUnique({ where: { id: dealId }, include: { stages: true } });
    if (!deal || deal.workerId !== workerId) throw new DealError("Only the worker can add extra work");
    if (deal.status !== "ACTIVE") throw new DealError("Extra work can only be added to an active deal");
    const position = Math.max(...deal.stages.map((x) => x.position)) + 1;
    await tx.stage.create({
      data: {
        dealId, position, title: s.title.trim(), amount: s.amountKobo, fee: stageFee(s.amountKobo),
        isChangeOrder: true, status: "PENDING_APPROVAL",
      },
    });
    await log(tx, dealId, workerId, "CHANGE_ORDER_ADDED",
      `Extra work proposed: "${s.title.trim()}" for ${formatNaira(s.amountKobo)}. Waiting for the client to accept.`);
  });
}

export async function respondChangeOrder(stageId: string, clientId: string, accept: boolean) {
  return prisma.$transaction(async (tx) => {
    const stage = await loadStage(tx, stageId);
    if (stage.deal.clientId !== clientId) throw new DealError("Only the client can respond");
    await moveStage(tx, stageId, ["PENDING_APPROVAL"], { status: accept ? "UNFUNDED" : "CANCELLED", closedAt: accept ? null : new Date() });
    await log(tx, stage.dealId, clientId, accept ? "CHANGE_ORDER_ACCEPTED" : "CHANGE_ORDER_DECLINED",
      `Client ${accept ? "accepted" : "declined"} the extra work "${stage.title}".`);
    if (!accept) await maybeComplete(tx, stage.dealId);
  });
}

/**
 * The worker can cancel at any time: money locked for unfinished stages goes back to the client.
 * The client can only cancel while no money is locked; otherwise they raise an issue.
 */
export async function cancelDeal(dealId: string, userId: string, reason: string) {
  await prisma.$transaction(async (tx) => {
    const deal = await tx.deal.findUnique({ where: { id: dealId }, include: { stages: true } });
    if (!deal) throw new DealError("Deal not found");
    const isWorker = deal.workerId === userId;
    const isClient = deal.clientId === userId;
    if (!isWorker && !isClient) throw new DealError("Only the people on this deal can cancel it");
    if (!["AWAITING_CLIENT", "ACTIVE"].includes(deal.status)) throw new DealError("This deal is already closed");
    if (deal.stages.some((s) => s.status === "DISPUTED")) throw new DealError("Settle the open issue before cancelling");
    const locked = deal.stages.filter((s) => LOCKED_STAGE.includes(s.status));
    if (isClient && locked.length) throw new DealError("Money is locked for work in progress. Raise an issue on that stage instead.");

    for (const s of locked) {
      await moveStage(tx, s.id, ["FUNDED", "IN_REVIEW"], { status: "REFUNDED", closedAt: new Date() });
      await post(tx, {
        reference: `refund:${s.id}`,
        kind: "REFUND",
        stageId: s.id,
        memo: "Worker cancelled the deal",
        entries: [
          { account: ACCOUNTS.escrow(s.id), amount: s.amount + s.fee },
          { account: ACCOUNTS.userPayable(deal.clientId!), amount: -(s.amount + s.fee) },
        ],
      });
    }
    // Money saved towards stages that never started goes back in full.
    let savedBack = 0;
    for (const s of deal.stages.filter((x) => x.status === "PARTLY_FUNDED")) {
      const saved = await held(tx, ACCOUNTS.escrow(s.id));
      await moveStage(tx, s.id, ["PARTLY_FUNDED"], { status: "REFUNDED", closedAt: new Date() });
      await post(tx, {
        reference: `refund:${s.id}`,
        kind: "REFUND",
        stageId: s.id,
        memo: "Deal cancelled while the client was paying in parts",
        entries: [
          { account: ACCOUNTS.escrow(s.id), amount: saved },
          { account: ACCOUNTS.userPayable(deal.clientId!), amount: -saved },
        ],
      });
      savedBack += saved;
    }
    await tx.instalmentPlan.updateMany({ where: { stage: { dealId } }, data: { active: false } });
    await tx.stage.updateMany({
      where: { dealId, status: { in: ["UNFUNDED", "PENDING_APPROVAL"] } },
      data: { status: "CANCELLED", closedAt: new Date() },
    });
    await tx.deal.update({ where: { id: dealId }, data: { status: "CANCELLED" } });
    const refunded = locked.reduce((n, s) => n + s.amount + s.fee, 0) + savedBack;
    await log(tx, dealId, userId, "DEAL_CANCELLED",
      `${isWorker ? "Worker" : "Client"} cancelled the deal${reason ? `: ${reason}` : "."}${refunded ? ` ${formatNaira(refunded)} returned to the client.` : ""}`);
  });
  await settleDeal(dealId);
}

// ---------- ratings and trust ----------

export async function rateDeal(dealId: string, fromId: string, stars: number, comment: string) {
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new DealError("Choose 1 to 5 stars");
  const deal = await prisma.deal.findUnique({ where: { id: dealId } });
  if (!deal || !deal.clientId) throw new DealError("Deal not found");
  if (!["COMPLETED", "CANCELLED"].includes(deal.status)) throw new DealError("You can rate once the deal is closed");
  const toId = fromId === deal.workerId ? deal.clientId : fromId === deal.clientId ? deal.workerId : null;
  if (!toId) throw new DealError("Only the people on this deal can rate it");
  try {
    await prisma.rating.create({ data: { dealId, fromId, toId, stars, comment: comment.trim() } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new DealError("You have already rated this deal");
    throw e;
  }
}

export async function trustProfile(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;
  const [asWorker, asClient, ratings, agg, disputesAgainst, disputesRaised] = await Promise.all([
    prisma.deal.count({ where: { workerId: userId, status: "COMPLETED" } }),
    prisma.deal.count({ where: { clientId: userId, status: "COMPLETED" } }),
    prisma.rating.findMany({ where: { toId: userId }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.rating.aggregate({ where: { toId: userId }, _avg: { stars: true }, _count: true }),
    prisma.dispute.count({ where: { stage: { deal: { workerId: userId } } } }),
    prisma.dispute.count({ where: { raisedById: userId } }),
  ]);
  return {
    user, asWorker, asClient, ratings, avgStars: agg._avg.stars, ratingCount: agg._count, disputesAgainst, disputesRaised,
  };
}
