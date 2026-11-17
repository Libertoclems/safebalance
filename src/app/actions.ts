"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser, logout, quickLogin, requestOtp, requireUser, verifyOtp } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  acceptDeal, addChangeOrder, approveStage, cancelDeal, createDeal, DealError, fastForwardReview,
  prepareFunding, raiseDispute, rateDeal, resolveDispute, respondChangeOrder, submitProof, type NewStage,
} from "@/lib/deals";
import { cancelPlan, EVERY, savingProgress, setPlan } from "@/lib/instalments";
import { formatNaira, nairaToKobo } from "@/lib/money";
import { getProvider, isTestMode } from "@/lib/payments";
import { signSandbox } from "@/lib/payments/sandbox";
import { settleUser } from "@/lib/payouts";
import { addStatement, decideSuggestion, kickMediation, processDueMediations } from "@/lib/mediator";
import { saveUpload } from "@/lib/uploads";
import { dispatchNotifications } from "@/lib/whatsapp/notify";

export type FormState = { error?: string; ok?: string; testCode?: string; step?: "code" } | undefined;

/** Run an action and turn DealErrors into a message for the form. */
async function attempt(fn: () => Promise<FormState | void>): Promise<FormState> {
  try {
    const result = (await fn()) ?? { ok: "Done" };
    await dispatchNotifications().catch((e) => console.error("[notify]", e)); // tell the other side on WhatsApp
    return result;
  } catch (e) {
    if (e instanceof DealError) return { error: e.message };
    console.error(e);
    return { error: "Something went wrong. Please try again." };
  }
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

function amount(text: string) {
  try {
    return nairaToKobo(text);
  } catch {
    throw new DealError(`"${text}" is not a valid amount`);
  }
}

async function dealPath(dealId: string) {
  const d = await prisma.deal.findUniqueOrThrow({ where: { id: dealId }, select: { code: true } });
  return `/d/${d.code}`;
}

// ---------- sign in ----------

export async function sendCodeAction(_: FormState, fd: FormData): Promise<FormState> {
  return attempt(async () => {
    const r = await requestOtp(str(fd, "phone"));
    return { step: "code", testCode: r.testCode, ok: "Code sent" };
  });
}

export async function verifyCodeAction(_: FormState, fd: FormData): Promise<FormState> {
  const next = str(fd, "next") || "/dashboard";
  const result = await attempt(async () => {
    await verifyOtp(str(fd, "phone"), str(fd, "code"), str(fd, "name"));
  });
  if (result?.error) return { ...result, step: "code" };
  redirect(next.startsWith("/") ? next : "/dashboard");
}

/** Test mode only: sign in with phone and name, no code. */
export async function quickLoginAction(_: FormState, fd: FormData): Promise<FormState> {
  const next = str(fd, "next") || "/dashboard";
  const result = await attempt(async () => {
    await quickLogin(str(fd, "phone"), str(fd, "name"));
  });
  if (result?.error) return result;
  redirect(next.startsWith("/") ? next : "/dashboard");
}

export async function logoutAction() {
  await logout();
  redirect("/");
}

// ---------- profile ----------

export async function saveProfileAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser("/settings");
  return attempt(async () => {
    const name = str(fd, "name");
    const bankName = str(fd, "bankName");
    const accountNumber = str(fd, "accountNumber");
    const accountName = str(fd, "accountName");
    if (!name) throw new DealError("Enter your name");
    if (accountNumber || bankName) {
      if (!bankName) throw new DealError("Choose your bank");
      const resolved = await getProvider().resolveAccount({ bankName, accountNumber });
      if (!accountName && !resolved.accountName) throw new DealError("Enter the name on the account");
    }
    await prisma.user.update({
      where: { id: user.id },
      data: {
        name,
        bankName: bankName || null,
        bankAccountNumber: accountNumber || null,
        bankAccountName: accountName || null,
      },
    });
    await settleUser(user.id); // pay out anything waiting
    revalidatePath("/settings");
    return { ok: "Saved. Money owed to you is sent here automatically." };
  });
}

/** Pilot stand-in for a real BVN/NIN check through an identity provider. */
export async function verifyIdAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser("/settings");
  return attempt(async () => {
    if (!isTestMode()) throw new DealError("Identity checks are not connected yet");
    const idType = str(fd, "idType");
    const idNumber = str(fd, "idNumber").replace(/\D/g, "");
    if (!["BVN", "NIN"].includes(idType)) throw new DealError("Choose BVN or NIN");
    if (idNumber.length !== 11) throw new DealError(`${idType} must be 11 digits`);
    // Production: call Smile ID / Dojah / Prembly here. Never store the full number.
    await prisma.user.update({ where: { id: user.id }, data: { idVerified: true, idType } });
    await settleUser(user.id);
    revalidatePath("/settings");
    return { ok: `${idType} verified (test mode)` };
  });
}

// ---------- deals ----------

export async function createDealAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser("/deals/new");
  let code = "";
  const result = await attempt(async () => {
    const titles = fd.getAll("stageTitle").map(String);
    const amounts = fd.getAll("stageAmount").map(String);
    const kinds = fd.getAll("stageKind").map(String);
    const supNames = fd.getAll("supplierName").map(String);
    const supBanks = fd.getAll("supplierBank").map(String);
    const supAccts = fd.getAll("supplierAcct").map(String);
    const stages: NewStage[] = titles.map((title, i) => ({
      title,
      amountKobo: amount(amounts[i]),
      kind: kinds[i] === "MATERIALS" ? "MATERIALS" : "WORK",
      supplierName: supNames[i],
      supplierBank: supBanks[i],
      supplierAcct: supAccts[i]?.replace(/\D/g, ""),
    }));
    const deal = await createDeal(user.id, {
      title: str(fd, "title"),
      description: str(fd, "description"),
      reviewHours: Number(str(fd, "reviewHours") || 72),
      stages,
    });
    code = deal.code;
  });
  if (result?.error) return result;
  redirect(`/d/${code}?created=1`);
}

export async function acceptDealAction(_: FormState, fd: FormData): Promise<FormState> {
  const code = str(fd, "code");
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/d/${code}`);
  return attempt(async () => {
    await acceptDeal(str(fd, "dealId"), user.id);
    revalidatePath(`/d/${code}`);
    return { ok: "Terms accepted. You can now fund the first stage." };
  });
}

export async function prepareFundingAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  return attempt(async () => {
    const s = await prepareFunding(str(fd, "stageId"), user.id);
    revalidatePath(await dealPath(s.dealId));
  });
}

/** Test mode only: pretend the client made the bank transfer, through the real webhook route. */
export async function simulateTransferAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  return attempt(async () => {
    if (!isTestMode()) throw new DealError("Only available in test mode");
    const stage = await prisma.stage.findUniqueOrThrow({ where: { id: str(fd, "stageId") }, include: { deal: true } });
    if (stage.deal.clientId !== user.id) throw new DealError("Only the client can pay");
    if (!stage.paymentRef) throw new DealError("Get the payment details first");
    const { remaining } = await savingProgress(stage.id);
    const amountKobo = Number(str(fd, "amount")) || remaining; // a part payment, or everything left
    const body = JSON.stringify({
      id: `sbx_evt_${crypto.randomUUID()}`,
      event: "transfer.received",
      data: { reference: stage.paymentRef, amount: amountKobo, sender_name: user.name },
    });
    const res = await fetch(`${process.env.APP_URL ?? "http://localhost:3000"}/api/webhooks/sandbox`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sandbox-signature": signSandbox(body) },
      body,
    });
    if (!res.ok) throw new DealError(`The test bank could not deliver the transfer (${res.status})`);
    revalidatePath(`/d/${stage.deal.code}`);
    return { ok: "Transfer received (test mode)" };
  });
}

export async function submitProofAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  return attempt(async () => {
    const stageId = str(fd, "stageId");
    const file = fd.get("file") as File;
    const saved = await saveUpload(file);
    const lat = Number(str(fd, "lat")) || null;
    const lng = Number(str(fd, "lng")) || null;
    await submitProof(stageId, user.id, { ...saved, note: str(fd, "note"), lat, lng });
    const stage = await prisma.stage.findUniqueOrThrow({ where: { id: stageId } });
    revalidatePath(await dealPath(stage.dealId));
    return { ok: "Proof uploaded. The client has been asked to review it." };
  });
}

export async function approveStageAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  return attempt(async () => {
    const stageId = str(fd, "stageId");
    await approveStage(stageId, user.id);
    const stage = await prisma.stage.findUniqueOrThrow({ where: { id: stageId } });
    revalidatePath(await dealPath(stage.dealId));
    return { ok: "Approved. Payment released to the worker." };
  });
}

export async function raiseDisputeAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  return attempt(async () => {
    const stageId = str(fd, "stageId");
    await raiseDispute(stageId, user.id, str(fd, "reason"));
    const stage = await prisma.stage.findUniqueOrThrow({ where: { id: stageId } });
    revalidatePath(await dealPath(stage.dealId));
    return { ok: "Issue raised. The money stays locked while it is settled." };
  });
}

export async function addChangeOrderAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  return attempt(async () => {
    const dealId = str(fd, "dealId");
    await addChangeOrder(dealId, user.id, { title: str(fd, "title"), amountKobo: amount(str(fd, "amount")) });
    revalidatePath(await dealPath(dealId));
    return { ok: "Extra work sent to the client for approval." };
  });
}

export async function respondChangeOrderAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  return attempt(async () => {
    const stageId = str(fd, "stageId");
    await respondChangeOrder(stageId, user.id, str(fd, "accept") === "yes");
    const stage = await prisma.stage.findUniqueOrThrow({ where: { id: stageId } });
    revalidatePath(await dealPath(stage.dealId));
  });
}

export async function cancelDealAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  return attempt(async () => {
    const dealId = str(fd, "dealId");
    await cancelDeal(dealId, user.id, str(fd, "reason"));
    revalidatePath(await dealPath(dealId));
    return { ok: "Deal cancelled." };
  });
}

export async function rateAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  return attempt(async () => {
    const dealId = str(fd, "dealId");
    await rateDeal(dealId, user.id, Number(str(fd, "stars")), str(fd, "comment"));
    revalidatePath(await dealPath(dealId));
    return { ok: "Thanks for your rating." };
  });
}

export async function fastForwardAction(_: FormState, fd: FormData): Promise<FormState> {
  await requireUser();
  return attempt(async () => {
    const stageId = str(fd, "stageId");
    await fastForwardReview(stageId);
    const stage = await prisma.stage.findUniqueOrThrow({ where: { id: stageId } });
    revalidatePath(await dealPath(stage.dealId));
    return { ok: "Review window ended (test mode). Payment released automatically." };
  });
}

// ---------- pay small small ----------

export async function setPlanAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  return attempt(async () => {
    const stageId = str(fd, "stageId");
    const r = await setPlan(stageId, user.id, Number(str(fd, "parts")), str(fd, "every"));
    revalidatePath(await dealPath(r.stage.dealId));
    return { ok: `Plan set: ${r.parts} parts of about ${formatNaira(r.instalment)}, ${EVERY[r.every]}. We'll remind you on WhatsApp.` };
  });
}

export async function cancelPlanAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  return attempt(async () => {
    const stageId = str(fd, "stageId");
    await cancelPlan(stageId, user.id);
    const stage = await prisma.stage.findUniqueOrThrow({ where: { id: stageId } });
    revalidatePath(await dealPath(stage.dealId));
    return { ok: "Plan stopped. Money already saved stays locked for this stage." };
  });
}

// ---------- mediation ----------

async function disputeDealPath(disputeId: string) {
  const d = await prisma.dispute.findUniqueOrThrow({ where: { id: disputeId }, include: { stage: true } });
  return dealPath(d.stage.dealId);
}

export async function addStatementAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  return attempt(async () => {
    const disputeId = str(fd, "disputeId");
    await addStatement(disputeId, user.id, str(fd, "text"));
    kickMediation(disputeId); // runs in the background; the page shows progress
    revalidatePath(await disputeDealPath(disputeId));
    return { ok: "Your side has been recorded. The mediator is looking at the evidence." };
  });
}

export async function decideSuggestionAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  return attempt(async () => {
    const disputeId = str(fd, "disputeId");
    const r = await decideSuggestion(disputeId, user.id, str(fd, "accept") === "yes");
    revalidatePath(await disputeDealPath(disputeId));
    return {
      ok: r.outcome === "settled" ? "You both accepted. The money has been paid out as suggested."
        : r.outcome === "waiting" ? "You accepted. Waiting for the other side."
        : "A human mediator will review the issue.",
    };
  });
}

/** Test mode only: end the worker's response window now. */
export async function skipResponseWindowAction(_: FormState, fd: FormData): Promise<FormState> {
  await requireUser();
  return attempt(async () => {
    if (!isTestMode()) throw new DealError("Only available in test mode");
    const disputeId = str(fd, "disputeId");
    await prisma.dispute.updateMany({
      where: { id: disputeId, aiStatus: "WAITING_RESPONSE" },
      data: { responseDeadline: new Date(Date.now() - 1000) },
    });
    await processDueMediations();
    revalidatePath(await disputeDealPath(disputeId));
    return { ok: "Response window ended (test mode)." };
  });
}

// ---------- admin ----------

export async function resolveDisputeAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser("/admin");
  return attempt(async () => {
    if (user.role !== "admin") throw new DealError("Admins only");
    await resolveDispute(str(fd, "disputeId"), user.id, amount(str(fd, "workerShare") || "0"), str(fd, "note"));
    revalidatePath("/admin");
    return { ok: "Dispute settled and payouts sent." };
  });
}
