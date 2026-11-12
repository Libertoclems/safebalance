import { prisma } from "../db";
import { DealError, logDealEvent, resolveDispute } from "../deals";
import { formatNaira, proRataFee } from "../money";
import { dispatchNotifications } from "../whatsapp/notify";
import { defaultEngine } from "./engines";
import { buildEvidence } from "./evidence";
import type { MediatorEngine, StoredSuggestion } from "./types";

// AI-assisted mediation. Flow for one dispute:
//   WAITING_RESPONSE  worker has RESPONSE_HOURS to give their side
//   PENDING           ready for the mediator (worker answered, or time ran out)
//   RUNNING           the mediator is working on it
//   READY             suggestion shown to both; paid out only if BOTH accept
//   NEEDS_HUMAN       a person decides (low confidence, large amount, rejected, AI unavailable)
// An admin can settle any open dispute at any time from the admin page.

const MAX_ATTEMPTS = 3;
const MIN_STATEMENT = 10;
const MAX_STATEMENT = 2000;
const MAX_STATEMENTS_EACH = 2;

let engineOverride: MediatorEngine | null | undefined;
/** Tests use this to plug in a fake mediator. */
export function setMediatorEngine(engine: MediatorEngine | null | undefined) {
  engineOverride = engine;
}
function engine() {
  return engineOverride !== undefined ? engineOverride : defaultEngine();
}

/** Disputes above this amount always go to a person. Default ₦1,000,000. */
function maxAutoKobo() {
  return Number(process.env.MEDIATOR_MAX_AUTO_NAIRA ?? 1_000_000) * 100;
}

async function loadDispute(disputeId: string) {
  const d = await prisma.dispute.findUnique({ where: { id: disputeId }, include: { stage: { include: { deal: true } } } });
  if (!d) throw new DealError("Dispute not found");
  return d;
}

function roleOf(d: Awaited<ReturnType<typeof loadDispute>>, userId: string) {
  if (userId === d.stage.deal.workerId) return "WORKER" as const;
  if (userId === d.stage.deal.clientId) return "CLIENT" as const;
  throw new DealError("Only the worker and client on this deal can take part");
}

export function readSuggestion(json: string | null): StoredSuggestion | null {
  return json ? (JSON.parse(json) as StoredSuggestion) : null;
}

// ---------- statements ----------

/** A party gives their side. The worker's first answer starts mediation straight away. */
export async function addStatement(disputeId: string, userId: string, text: string) {
  const clean = text.trim();
  if (clean.length < MIN_STATEMENT) throw new DealError("Please explain in a sentence or two");
  if (clean.length > MAX_STATEMENT) throw new DealError(`Please keep it under ${MAX_STATEMENT} characters`);

  const d = await loadDispute(disputeId);
  const role = roleOf(d, userId);
  if (d.status !== "OPEN") throw new DealError("This issue has already been settled");
  if (!["WAITING_RESPONSE", "PENDING"].includes(d.aiStatus)) {
    throw new DealError("The mediator has already looked at this issue, so new statements can't be added");
  }
  const count = await prisma.disputeStatement.count({ where: { disputeId, role } });
  if (count >= MAX_STATEMENTS_EACH) throw new DealError("You've already given your side");

  await prisma.$transaction(async (tx) => {
    await tx.disputeStatement.create({ data: { disputeId, userId, role, text: clean } });
    if (role === "WORKER") {
      await tx.dispute.updateMany({ where: { id: disputeId, aiStatus: "WAITING_RESPONSE" }, data: { aiStatus: "PENDING" } });
    }
    await logDealEvent(tx, d.stage.dealId, userId, "DISPUTE_STATEMENT",
      `${role === "WORKER" ? "The worker" : "The client"} gave their side on "${d.stage.title}": "${clean.slice(0, 300)}"` +
        (role === "WORKER" ? "\n\nThe mediator will now suggest a fair outcome." : ""));
  });
  await dispatchNotifications().catch(() => undefined);
}

// ---------- running the mediator ----------

async function escalate(disputeId: string, dealId: string, reason: string, actorId: string | null = null) {
  await prisma.$transaction(async (tx) => {
    const r = await tx.dispute.updateMany({
      where: { id: disputeId, escalated: false },
      data: { escalated: true, escalationReason: reason },
    });
    if (r.count) {
      await logDealEvent(tx, dealId, actorId, "DISPUTE_ESCALATED",
        `${reason} A human mediator will review the issue and contact you both within 5 working days. The money stays locked until then.`);
    }
  });
}

/** Ask the mediator for a suggestion. Safe to call repeatedly: only one run happens per dispute. */
export async function runMediation(disputeId: string) {
  const d = await loadDispute(disputeId);
  if (d.status !== "OPEN") return null;
  const mediator = engine();

  if (!mediator) {
    const r = await prisma.dispute.updateMany({ where: { id: disputeId, aiStatus: "PENDING" }, data: { aiStatus: "OFF" } });
    if (r.count) await escalate(disputeId, d.stage.dealId, "Automatic mediation is turned off.");
    await dispatchNotifications().catch(() => undefined);
    return null;
  }

  // Claim the run so two callers can't both run it.
  const claimed = await prisma.dispute.updateMany({
    where: { id: disputeId, status: "OPEN", aiStatus: "PENDING" },
    data: { aiStatus: "RUNNING", aiAttempts: { increment: 1 }, aiAt: new Date() },
  });
  if (claimed.count !== 1) return null;

  let result: Awaited<ReturnType<MediatorEngine["suggest"]>>;
  let evidence: Awaited<ReturnType<typeof buildEvidence>>;
  try {
    evidence = await buildEvidence(disputeId);
    result = await mediator.suggest(evidence);
  } catch (e) {
    const attempts = d.aiAttempts + 1;
    const giveUp = attempts >= MAX_ATTEMPTS;
    await prisma.dispute.update({
      where: { id: disputeId },
      data: { aiStatus: giveUp ? "NEEDS_HUMAN" : "FAILED", aiError: String(e).slice(0, 500) },
    });
    if (giveUp) await escalate(disputeId, d.stage.dealId, "The AI mediator could not be reached.");
    await dispatchNotifications().catch(() => undefined);
    return null;
  }

  if (!result.ok) {
    const giveUp = result.needsHuman || d.aiAttempts + 1 >= MAX_ATTEMPTS;
    await prisma.dispute.update({
      where: { id: disputeId },
      data: { aiStatus: giveUp ? "NEEDS_HUMAN" : "FAILED", aiError: result.reason },
    });
    if (giveUp) await escalate(disputeId, d.stage.dealId, "This issue needs a person to look at it.");
    await dispatchNotifications().catch(() => undefined);
    return null;
  }

  // Never trust the model's arithmetic: clamp the share and work out naira ourselves.
  const s = result.suggestion;
  const pct = Math.min(100, Math.max(0, Math.round(Number.isFinite(s.workerSharePercent) ? s.workerSharePercent : 50)));
  const amount = d.stage.amount;
  const workerShareKobo = Math.round((amount * pct) / 100 / 100) * 100; // whole naira
  const stored: StoredSuggestion = {
    ...s,
    workerSharePercent: pct,
    workerShareKobo,
    refundKobo: amount - workerShareKobo,
    imagesShown: evidence.images.length,
    imagesSkipped: evidence.imagesSkipped,
  };

  const humanReason = s.needsHuman
    ? s.needsHumanReason || "The mediator flagged this issue for a person."
    : s.confidence === "low"
      ? "The evidence isn't clear enough for an automatic suggestion."
      : amount > maxAutoKobo()
        ? `Issues over ${formatNaira(maxAutoKobo())} are always decided by a person.`
        : null;

  await prisma.$transaction(async (tx) => {
    await tx.dispute.update({
      where: { id: disputeId },
      data: {
        aiStatus: humanReason ? "NEEDS_HUMAN" : "READY",
        aiSuggestion: JSON.stringify(stored),
        aiSource: result.source,
        aiError: null,
        aiAt: new Date(),
        ...(humanReason ? { escalated: true, escalationReason: humanReason } : {}),
      },
    });
    if (humanReason) {
      await logDealEvent(tx, d.stage.dealId, null, "DISPUTE_ESCALATED",
        `${humanReason} A human mediator will review the issue on "${d.stage.title}" and contact you both within 5 working days. The money stays locked until then.`);
    } else {
      const buttons = [
        { id: `med_yes:${disputeId}`, title: "Accept" },
        { id: `med_no:${disputeId}`, title: "Reject" },
      ];
      await logDealEvent(tx, d.stage.dealId, null, "MEDIATION_SUGGESTED",
        `Mediator's suggestion for "${d.stage.title}"${result.source === "demo" ? " (DEMO, not a real assessment)" : ""}:\n` +
          `${formatNaira(workerShareKobo)} to the worker, ` +
          `${formatNaira(amount - workerShareKobo + d.stage.fee - proRataFee(d.stage.fee, workerShareKobo, amount))} back to the client (including the unused part of the fee).\n\n` +
          `${s.reasoning}\n\n` +
          (s.nextSteps.length ? `Next steps: ${s.nextSteps.join("; ")}\n\n` : "") +
          "Nothing is paid unless you BOTH accept. If either of you rejects it, a human mediator decides.",
        { buttons: { worker: buttons, client: buttons } });
    }
  });
  await dispatchNotifications().catch(() => undefined);
  return stored;
}

const inFlight = new Set<Promise<unknown>>();

/** Start mediation in the background (don't make the person wait for it). */
export function kickMediation(disputeId: string) {
  const p = runMediation(disputeId)
    .catch((e) => console.error("[mediator]", e))
    .finally(() => inFlight.delete(p));
  inFlight.add(p);
}

/** Tests: wait for background mediation runs to finish. */
export async function waitForMediations() {
  while (inFlight.size) await Promise.all([...inFlight]);
}

// ---------- accepting or rejecting ----------

export async function decideSuggestion(disputeId: string, userId: string, accept: boolean) {
  const d = await loadDispute(disputeId);
  const role = roleOf(d, userId);
  if (d.status !== "OPEN") throw new DealError("This issue has already been settled");
  if (d.aiStatus !== "READY" || d.escalated) throw new DealError("There is no suggestion waiting for your answer");
  const field = role === "WORKER" ? "workerDecision" : "clientDecision";
  const who = role === "WORKER" ? "The worker" : "The client";

  const r = await prisma.dispute.updateMany({
    where: { id: disputeId, [field]: null },
    data: { [field]: accept ? "ACCEPT" : "REJECT" },
  });
  if (r.count !== 1) throw new DealError("You've already answered");

  if (!accept) {
    await escalate(disputeId, d.stage.dealId, `${who} rejected the mediator's suggestion.`, userId);
    await dispatchNotifications().catch(() => undefined);
    return { outcome: "escalated" as const };
  }

  const fresh = await prisma.dispute.findUniqueOrThrow({ where: { id: disputeId } });
  if (fresh.workerDecision === "ACCEPT" && fresh.clientDecision === "ACCEPT") {
    const s = readSuggestion(fresh.aiSuggestion)!;
    try {
      await resolveDispute(disputeId, "mediation", s.workerShareKobo,
        "Both sides accepted the mediator's suggestion.");
    } catch (e) {
      if (!(e instanceof DealError)) throw e; // already settled by a parallel tap
    }
    await dispatchNotifications().catch(() => undefined);
    return { outcome: "settled" as const };
  }

  await prisma.$transaction((tx) =>
    logDealEvent(tx, d.stage.dealId, userId, "MEDIATION_ACCEPTED",
      `${who} accepted the mediator's suggestion. Waiting for the other side.`),
  );
  await dispatchNotifications().catch(() => undefined);
  return { outcome: "waiting" as const };
}

// ---------- timer ----------

/** Run by the background worker: start mediation when the response window ends, retry failures. */
export async function processDueMediations(now = new Date()) {
  const expired = await prisma.dispute.findMany({
    where: { status: "OPEN", aiStatus: "WAITING_RESPONSE", responseDeadline: { lte: now } },
    include: { stage: true },
  });
  for (const d of expired) {
    const r = await prisma.dispute.updateMany({ where: { id: d.id, aiStatus: "WAITING_RESPONSE" }, data: { aiStatus: "PENDING" } });
    if (r.count) {
      await prisma.$transaction((tx) =>
        logDealEvent(tx, d.stage.dealId, null, "DISPUTE_NO_RESPONSE",
          `The worker didn't give their side on "${d.stage.title}" in time. The mediator will now look at the evidence.`),
      );
    }
  }
  // Runs that crashed mid-way (e.g. server restart) and failed runs get another go.
  await prisma.dispute.updateMany({
    where: { status: "OPEN", aiStatus: "RUNNING", aiAt: { lte: new Date(now.getTime() - 10 * 60_000) } },
    data: { aiStatus: "PENDING" },
  });
  await prisma.dispute.updateMany({
    where: { status: "OPEN", aiStatus: "FAILED", aiAttempts: { lt: MAX_ATTEMPTS } },
    data: { aiStatus: "PENDING" },
  });

  const pending = await prisma.dispute.findMany({ where: { status: "OPEN", aiStatus: "PENDING" }, select: { id: true } });
  for (const p of pending) await runMediation(p.id);
  return pending.length;
}
