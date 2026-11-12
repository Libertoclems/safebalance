import crypto from "node:crypto";
import { Prisma, type Deal, type Stage, type User } from "@prisma/client";
import { prisma } from "../db";
import {
  acceptDeal, approveStage, createDeal, DealError, dealUrl, prepareFunding, raiseDispute,
  recordIncomingTransfer, respondChangeOrder, submitProof, type NewStage,
} from "../deals";
import { STAGE_LABEL, DEAL_LABEL } from "../labels";
import { EVERY, lockedNow, savingProgress, schedule, setPlan, type Every } from "../instalments";
import { addStatement, decideSuggestion, kickMediation } from "../mediator";
import { formatNaira, nairaToKobo, stageFee } from "../money";
import { isTestMode } from "../payments";
import { saveBuffer } from "../uploads";
import { dispatchNotifications } from "./notify";
import { downloadMedia, sendMessage, waLink, type Button, type OutMessage } from "./transport";

// The SafeBalance WhatsApp bot. Every action goes through the same deal rules
// as the web app (src/lib/deals.ts), so the same checks apply.

export type Incoming = {
  from: string; // WhatsApp id, digits only
  name?: string; // WhatsApp profile name
  messageId: string;
  kind: "text" | "button" | "image" | "video" | "other";
  text?: string;
  buttonId?: string;
  mediaId?: string;
  mimeType?: string;
  caption?: string;
};

type State = "IDLE" | "NEW_TITLE" | "NEW_STAGES" | "NEW_CONFIRM" | "PICK_DEAL" | "ISSUE_REASON" | "AWAIT_PROOF" | "DISPUTE_SIDE";
type Data = {
  title?: string;
  stages?: NewStage[];
  dealIds?: string[];
  stageId?: string;
  disputeId?: string;
};
type Ctx = { phone: string; user: User; state: State; data: Data; reply: (m: OutMessage | string) => Promise<void> };

const MENU_BUTTONS: Button[] = [
  { id: "new", title: "New deal" },
  { id: "deals", title: "My deals" },
  { id: "help", title: "Help" },
];

// ---------- entry point ----------

export async function handleIncoming(msg: Incoming) {
  // WhatsApp can deliver the same message twice; handle each once.
  try {
    await prisma.waMessage.create({
      data: {
        phone: msg.from,
        direction: "IN",
        waMessageId: msg.messageId,
        body: JSON.stringify({ text: msg.text ?? msg.caption, buttonId: msg.buttonId, kind: msg.kind, mediaId: msg.mediaId }),
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return;
    throw e;
  }

  const convo = await prisma.waConversation.upsert({
    where: { phone: msg.from },
    update: { lastInboundAt: new Date() },
    create: { phone: msg.from, lastInboundAt: new Date() },
  });

  // WhatsApp has already verified this number, so it identifies the user.
  const phone = "+" + msg.from;
  let user = await prisma.user.upsert({ where: { phone }, update: {}, create: { phone, name: msg.name?.trim() ?? "" } });
  if (!user.name && msg.name) user = await prisma.user.update({ where: { id: user.id }, data: { name: msg.name.trim() } });

  const ctx: Ctx = {
    phone: msg.from,
    user,
    state: convo.state as State,
    data: JSON.parse(convo.data) as Data,
    reply: (m) => sendMessage(msg.from, typeof m === "string" ? { text: m } : m),
  };

  try {
    await route(ctx, msg);
  } catch (e) {
    if (e instanceof DealError) {
      await ctx.reply({ text: `⚠️ ${e.message}`, buttons: [{ id: "menu", title: "Menu" }] });
    } else {
      console.error("[whatsapp] error", e);
      await ctx.reply({ text: "Sorry, something went wrong on our side. Please try again.", buttons: [{ id: "menu", title: "Menu" }] });
    }
  }
  await dispatchNotifications();
}

async function setState(ctx: Ctx, state: State, data: Data = {}) {
  ctx.state = state;
  ctx.data = data;
  await prisma.waConversation.update({ where: { phone: ctx.phone }, data: { state, data: JSON.stringify(data) } });
}

// ---------- routing ----------

async function route(ctx: Ctx, msg: Incoming) {
  if (msg.kind === "button" && msg.buttonId) return onButton(ctx, msg.buttonId);
  if (msg.kind === "image" || msg.kind === "video") return onMedia(ctx, msg);
  if (msg.kind !== "text" || !msg.text) {
    return ctx.reply("I can read text, button taps, photos and short videos. Reply MENU to see what I can do.");
  }

  const text = msg.text.trim();
  const upper = text.toUpperCase();

  if (/^(HI|HELLO|HEY|MENU|START|HOME)\b/.test(upper)) {
    await setState(ctx, "IDLE");
    return menu(ctx);
  }
  if (upper === "CANCEL" || upper === "STOP") {
    await setState(ctx, "IDLE");
    return ctx.reply({ text: "Okay, stopped. Nothing was saved.", buttons: MENU_BUTTONS });
  }
  const join = upper.match(/^JOIN\s+([A-Z0-9]{6,12})$/);
  if (join) return joinDeal(ctx, join[1]);

  switch (ctx.state) {
    case "NEW_TITLE":
      return onTitle(ctx, text);
    case "NEW_STAGES":
      return onStages(ctx, text);
    case "ISSUE_REASON":
      return onIssueReason(ctx, text);
    case "DISPUTE_SIDE":
      return onDisputeSide(ctx, text);
    case "PICK_DEAL": {
      const n = Number(text);
      const id = ctx.data.dealIds?.[n - 1];
      if (Number.isInteger(n) && id) return showDeal(ctx, id);
      break;
    }
  }

  if (upper === "NEW" || upper === "NEW DEAL") return startNew(ctx);
  if (upper === "DEALS" || upper === "MY DEALS") return listDeals(ctx);
  if (upper === "HELP") return help(ctx);
  return menu(ctx);
}

async function onButton(ctx: Ctx, id: string) {
  const [action, arg] = id.split(":");
  switch (action) {
    case "menu":
      await setState(ctx, "IDLE");
      return menu(ctx);
    case "new":
    case "restart":
      return startNew(ctx);
    case "deals":
      return listDeals(ctx);
    case "help":
      return help(ctx);
    case "cancel":
      await setState(ctx, "IDLE");
      return ctx.reply({ text: "Okay, stopped. Nothing was saved.", buttons: MENU_BUTTONS });
    case "create":
      return onCreate(ctx);
    case "deal":
      return showDeal(ctx, arg);
    case "accept":
      await acceptDeal(arg, ctx.user.id);
      await ctx.reply("Done ✅ You've accepted the terms.");
      return showDeal(ctx, arg);
    case "pay":
      return payStage(ctx, arg);
    case "sim":
      return simulateTransfer(ctx, arg);
    case "plan":
      return askParts(ctx, arg);
    case "planparts":
      return askEvery(ctx, arg, Number(id.split(":")[2]));
    case "planevery": {
      const [, stageId, parts, every] = id.split(":");
      return confirmPlan(ctx, stageId, Number(parts), every);
    }
    case "approve":
      return confirmApprove(ctx, arg);
    case "approve_yes":
      await approveStage(arg, ctx.user.id);
      await setState(ctx, "IDLE");
      return ctx.reply("Done ✅ The payment has been released to the worker.");
    case "issue":
      await setState(ctx, "ISSUE_REASON", { stageId: arg });
      return ctx.reply(
        "What's wrong? Describe it in one message, for example: \"3 cabinet doors don't close and the colour is not what we agreed.\"\n\nThe money stays locked until it's settled. Reply CANCEL to go back.",
      );
    case "respond":
      await setState(ctx, "DISPUTE_SIDE", { disputeId: arg });
      return ctx.reply(
        "Tell us your side in one message: what was agreed, what you did, and anything the client's complaint leaves out. The mediator also sees the proof photos you already sent.\n\nReply CANCEL to go back.",
      );
    case "med_yes":
    case "med_no": {
      const r = await decideSuggestion(arg, ctx.user.id, action === "med_yes");
      return ctx.reply(
        r.outcome === "settled"
          ? "Done ✅ You both accepted, so the money has been paid out as suggested."
          : r.outcome === "waiting"
            ? "Thanks, you accepted. We're waiting for the other side to answer."
            : "Noted. A human mediator will review the issue and contact you both within 5 working days.",
      );
    }
    case "co_yes":
    case "co_no":
      await respondChangeOrder(arg, ctx.user.id, action === "co_yes");
      await ctx.reply(action === "co_yes" ? "Extra work accepted ✅" : "Extra work declined.");
      return showDealForStage(ctx, arg);
    default:
      return menu(ctx);
  }
}

// ---------- menus ----------

async function menu(ctx: Ctx) {
  const hi = ctx.user.name ? `Hi ${ctx.user.name.split(" ")[0]} 👋` : "Hi 👋";
  return ctx.reply({
    text: `${hi} Welcome to SafeBalance.\n\nYour client's money is locked before you start each stage, so you always get your balance.\n\nWhat would you like to do?`,
    buttons: MENU_BUTTONS,
  });
}

async function help(ctx: Ctx) {
  return ctx.reply({
    text: [
      "*How SafeBalance works*",
      "1. You create a deal with stages and send the link to your client.",
      "2. The client pays each stage into a locked account before you start it.",
      "3. When a stage is done, send a photo here as proof.",
      "4. The client approves, or if they don't reply within the review window, you're paid automatically.",
      "",
      "*Things you can type*",
      "NEW – create a deal",
      "DEALS – see your deals",
      "JOIN <code> – open a deal someone sent you",
      "MENU – main menu · CANCEL – stop what you're doing",
    ].join("\n"),
    buttons: [{ id: "new", title: "New deal" }, { id: "deals", title: "My deals" }],
  });
}

// ---------- creating a deal ----------

async function startNew(ctx: Ctx) {
  await setState(ctx, "NEW_TITLE");
  return ctx.reply("What's the job? For example: *Install kitchen cabinets*\n\n(Reply CANCEL any time to stop.)");
}

async function onTitle(ctx: Ctx, text: string) {
  if (text.length < 3 || text.length > 120) return ctx.reply("Please describe the job in a few words (3 to 120 characters).");
  await setState(ctx, "NEW_STAGES", { title: text });
  return ctx.reply(
    [
      "Now list the stages and amounts, *one per line*. For example:",
      "",
      "Materials 200k",
      "Installation 250,000",
      "",
      "A stage whose name starts with *Materials* is paid to you as soon as the client pays, so you can buy materials.",
    ].join("\n"),
  );
}

/** Parse "Materials 200k" / "Installation - ₦250,000" lines into stages. */
export function parseStages(text: string): NewStage[] {
  const lines = text.split(/\n|;/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new DealError("Send at least one stage, like: Installation 250000");
  if (lines.length > 10) throw new DealError("A deal can have at most 10 stages");
  return lines.map((line, i) => {
    const m = line.match(/^(.*?)[\s:=\-–—]*(?:₦|N|NGN)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m)?\s*(?:naira)?$/i);
    if (!m || !m[1].trim()) {
      throw new DealError(`I couldn't read line ${i + 1}: "${line}". Write the stage name, then the amount, like: Installation 250000`);
    }
    const base = Number(m[2].replace(/,/g, ""));
    const mult = m[3]?.toLowerCase() === "k" ? 1_000 : m[3]?.toLowerCase() === "m" ? 1_000_000 : 1;
    const naira = Math.round(base * mult * 100) / 100;
    const title = m[1].trim().replace(/[\s:=\-–—]+$/, "");
    return {
      title,
      amountKobo: nairaToKobo(naira.toFixed(2)),
      kind: /^materials?\b/i.test(title) ? "MATERIALS" : "WORK",
    } satisfies NewStage;
  });
}

async function onStages(ctx: Ctx, text: string) {
  const stages = parseStages(text);
  const total = stages.reduce((n, s) => n + s.amountKobo, 0);
  const fees = stages.reduce((n, s) => n + stageFee(s.amountKobo), 0);
  await setState(ctx, "NEW_CONFIRM", { ...ctx.data, stages });
  const lines = stages.map(
    (s, i) => `${i + 1}. ${s.title} – ${formatNaira(s.amountKobo)}${s.kind === "MATERIALS" ? " (paid when client pays)" : ""}`,
  );
  return ctx.reply({
    text: [
      "Please check:",
      "",
      `*${ctx.data.title}*`,
      ...lines,
      "",
      `You receive: ${formatNaira(total)}`,
      `Client pays: ${formatNaira(total + fees)} (includes ${formatNaira(fees)} fee)`,
      "Review window: 72 hours",
    ].join("\n"),
    buttons: [
      { id: "create", title: "Create deal" },
      { id: "restart", title: "Start again" },
      { id: "cancel", title: "Cancel" },
    ],
  });
}

async function onCreate(ctx: Ctx) {
  if (ctx.state !== "NEW_CONFIRM" || !ctx.data.title || !ctx.data.stages) {
    return ctx.reply({ text: "That deal has already been created or was cancelled.", buttons: MENU_BUTTONS });
  }
  const { title, stages } = ctx.data;
  const deal = await createDeal(ctx.user.id, { title, stages });
  await setState(ctx, "IDLE");
  const total = stages.reduce((n, s) => n + s.amountKobo + stageFee(s.amountKobo), 0);
  await ctx.reply("Deal created ✅ Forward the next message to your client. I'll tell you when they accept and pay.");
  return ctx.reply(
    [
      `Hi! I've set up our job "${deal.title}" on SafeBalance.`,
      `Your money stays locked until each stage is done, and you can raise an issue if anything is wrong.`,
      "",
      `Total: ${formatNaira(total)} in ${stages.length} stage(s)`,
      `View and accept: ${dealUrl(deal.code)}`,
      `Or on WhatsApp: ${waLink(`JOIN ${deal.code}`)}`,
    ].join("\n"),
  );
}

// ---------- viewing deals ----------

type FullDeal = Deal & { stages: Stage[]; worker: User; client: User | null };

async function loadDeal(dealId: string): Promise<FullDeal> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { stages: { orderBy: { position: "asc" } }, worker: true, client: true },
  });
  if (!deal) throw new DealError("Deal not found");
  return deal;
}

async function listDeals(ctx: Ctx) {
  const deals = await prisma.deal.findMany({
    where: { OR: [{ workerId: ctx.user.id }, { clientId: ctx.user.id }] },
    orderBy: { createdAt: "desc" },
    take: 9,
  });
  if (deals.length === 0) {
    return ctx.reply({ text: "You have no deals yet.", buttons: [{ id: "new", title: "New deal" }, { id: "help", title: "Help" }] });
  }
  await setState(ctx, "PICK_DEAL", { dealIds: deals.map((d) => d.id) });
  const lines = deals.map(
    (d, i) => `${i + 1}. ${d.title} – ${DEAL_LABEL[d.status].text} (you're the ${d.workerId === ctx.user.id ? "worker" : "client"})`,
  );
  return ctx.reply(`*Your deals*\n${lines.join("\n")}\n\nReply with a number to open one.`);
}

async function showDealForStage(ctx: Ctx, stageId: string) {
  const s = await prisma.stage.findUnique({ where: { id: stageId } });
  if (s) return showDeal(ctx, s.dealId);
}

async function showDeal(ctx: Ctx, dealId: string) {
  const deal = await loadDeal(dealId);
  const isWorker = deal.workerId === ctx.user.id;
  const isClient = deal.clientId === ctx.user.id;
  if (!isWorker && !isClient) throw new DealError("Only the worker and client can see this deal");

  const locked = await lockedNow(deal.stages);
  const stageLines = deal.stages.map((s) => {
    const amount = isClient && s.status !== "CANCELLED" ? `${formatNaira(s.amount)} + ${formatNaira(s.fee)} fee` : formatNaira(s.amount);
    return `${s.position}. ${s.title} – ${amount} – ${STAGE_LABEL[s.status].text}`;
  });
  const text = [
    `*${deal.title}*`,
    `Worker: ${deal.worker.name || "–"} · Client: ${deal.client?.name || "waiting"}`,
    `Status: ${DEAL_LABEL[deal.status].text}`,
    "",
    ...stageLines,
    "",
    `Locked now: ${formatNaira(locked)}`,
    dealUrl(deal.code),
  ];

  const buttons: Button[] = [];
  let next: { state: State; data: Data } = { state: "IDLE", data: {} };

  if (isClient && deal.status === "ACTIVE") {
    const pendingExtra = deal.stages.find((s) => s.status === "PENDING_APPROVAL");
    const review = deal.stages.find((s) => s.status === "IN_REVIEW");
    const toFund = deal.stages.find((s) => s.status === "UNFUNDED" || s.status === "PARTLY_FUNDED");
    if (pendingExtra) {
      text.push("", `The worker added extra work: "${pendingExtra.title}" for ${formatNaira(pendingExtra.amount)}.`);
      buttons.push({ id: `co_yes:${pendingExtra.id}`, title: "Accept extra work" }, { id: `co_no:${pendingExtra.id}`, title: "Decline" });
    } else if (review) {
      text.push("", `Stage ${review.position} is waiting for your review.`);
      buttons.push({ id: `approve:${review.id}`, title: "Approve & pay" }, { id: `issue:${review.id}`, title: "Raise an issue" });
    } else if (toFund) {
      if (toFund.status === "PARTLY_FUNDED") {
        const p = await savingProgress(toFund.id);
        text.push("", `Stage ${toFund.position}: ${formatNaira(p.saved)} of ${formatNaira(p.target)} saved (${p.percent}%).`);
      }
      buttons.push({ id: `pay:${toFund.id}`, title: `Pay stage ${toFund.position}` });
    }
  }

  if (isWorker && deal.status === "ACTIVE") {
    const working = deal.stages.find((s) => ["FUNDED", "IN_REVIEW"].includes(s.status));
    if (working) {
      text.push("", `📸 Send a photo of the work for stage ${working.position} ("${working.title}") and I'll add it as proof.`);
      next = { state: "AWAIT_PROOF", data: { stageId: working.id } };
    } else {
      const saving = deal.stages.find((s) => s.status === "PARTLY_FUNDED");
      if (saving) {
        const p = await savingProgress(saving.id);
        text.push("", `The client is paying stage ${saving.position} in parts: ${formatNaira(p.saved)} of ${formatNaira(p.target)} saved (${p.percent}%). Don't start until it shows Funds secured.`);
      } else if (deal.stages.some((s) => s.status === "UNFUNDED")) {
        text.push("", "Waiting for the client to pay the next stage. Don't start until it shows Funds secured.");
      }
    }
  }
  if (isWorker && deal.status === "AWAITING_CLIENT") {
    text.push("", `Your client hasn't accepted yet. Send them: ${waLink(`JOIN ${deal.code}`)}`);
  }

  if (buttons.length < 3) buttons.push({ id: "deals", title: "My deals" });
  await setState(ctx, next.state, next.data);
  return ctx.reply({ text: text.join("\n"), buttons });
}

async function joinDeal(ctx: Ctx, code: string) {
  const found = await prisma.deal.findUnique({ where: { code } });
  if (!found) return ctx.reply(`I couldn't find a deal with code ${code}. Check the code and try again.`);
  if (found.workerId === ctx.user.id) {
    return ctx.reply(`That's your own deal. Send this to your client: ${waLink(`JOIN ${code}`)}`);
  }
  if (found.clientId === ctx.user.id) return showDeal(ctx, found.id);
  if (found.clientId || found.status !== "AWAITING_CLIENT") return ctx.reply("This deal already has a client.");

  const deal = await loadDeal(found.id);
  const total = deal.stages.reduce((n, s) => n + s.amount + s.fee, 0);
  const lines = deal.stages.map((s) => `${s.position}. ${s.title} – ${formatNaira(s.amount)} + ${formatNaira(s.fee)} fee`);
  return ctx.reply({
    text: [
      `*${deal.title}*`,
      `From: ${deal.worker.name || "the worker"}${deal.worker.idVerified ? " ✓ ID verified" : ""}`,
      deal.description ? `\n${deal.description.slice(0, 300)}` : "",
      "",
      ...lines,
      `Total: ${formatNaira(total)}`,
      "",
      "How it works: you pay each stage into a locked account before the work on it starts. The worker is paid when you approve, or automatically if you don't reply within 72 hours of them sending proof. If something's wrong, raise an issue and the money stays locked.",
    ].join("\n"),
    buttons: [
      { id: `accept:${deal.id}`, title: "Accept terms" },
      { id: "menu", title: "Not now" },
    ],
  });
}

// ---------- paying and approving ----------

async function payStage(ctx: Ctx, stageId: string) {
  const s = await prepareFunding(stageId, ctx.user.id);
  const p = await savingProgress(s.id);
  const buttons: Button[] = [];
  if (isTestMode()) {
    buttons.push({ id: `sim:${s.id}`, title: p.plan && p.nextAmount < p.remaining ? "Simulate part pay" : "Simulate transfer" });
  }
  if (!p.plan && p.remaining >= 2 * 100_00) buttons.push({ id: `plan:${s.id}`, title: "Pay in parts" });
  return ctx.reply({
    text: [
      p.saved > 0 ? `Saved so far: ${formatNaira(p.saved)} of ${formatNaira(p.target)} (${p.percent}%).` : "",
      p.plan
        ? `Your next part: *${formatNaira(p.nextAmount)}* (${formatNaira(p.remaining)} left in total). Transfer to:`
        : `Transfer ${p.saved > 0 ? "the remaining" : "exactly"} *${formatNaira(p.remaining)}* to:`,
      `Bank: ${s.accountBank}`,
      `Account number: *${s.accountNumber}*`,
      "",
      "This account is only for this stage. Every transfer to it is locked for this job; work starts once it's fully paid.",
      p.plan ? "" : "Don't have it all now? Tap *Pay in parts* (pay small small).",
      isTestMode() ? "\n(Test mode: no real money.)" : "",
    ].filter(Boolean).join("\n"),
    buttons: buttons.length ? buttons : undefined,
  });
}

/** Test mode only: pretend the client's bank transfer (or next part) arrived. */
async function simulateTransfer(ctx: Ctx, stageId: string) {
  if (!isTestMode()) throw new DealError("Only available in test mode");
  const s = await prisma.stage.findUnique({ where: { id: stageId }, include: { deal: true } });
  if (!s || s.deal.clientId !== ctx.user.id) throw new DealError("Only the client can pay");
  if (!s.paymentRef) throw new DealError("Tap Pay first to get the account details");
  const p = await savingProgress(s.id);
  const r = await recordIncomingTransfer(
    "sandbox",
    { eventId: `wa_sim_${crypto.randomUUID()}`, reference: s.paymentRef, amountKobo: p.nextAmount },
    "{}",
  );
  if (r.outcome === "suspense" || r.outcome === "duplicate") throw new DealError("That transfer didn't match this stage");
}

async function askParts(ctx: Ctx, stageId: string) {
  const p = await savingProgress(stageId);
  const opt = (n: number) => ({ id: `planparts:${stageId}:${n}`, title: `${n} parts` });
  return ctx.reply({
    text:
      `*Pay small small*\nSplit the ${formatNaira(p.remaining)} for this stage into parts. Your money is locked for this job as you pay ` +
      `(it doesn't earn interest), and work starts once it's fully paid. If the deal is cancelled first, you get everything back.\n\nHow many parts?`,
    buttons: [opt(2), opt(4), opt(6)],
  });
}

async function askEvery(ctx: Ctx, stageId: string, parts: number) {
  const p = await savingProgress(stageId);
  const each = Math.ceil(p.remaining / parts / 100) * 100;
  const opt = (k: Every) => ({ id: `planevery:${stageId}:${parts}:${k}`, title: EVERY[k].replace(/^every /, "Every ") });
  return ctx.reply({
    text: `${parts} parts of about ${formatNaira(each)}. How often will you pay?`,
    buttons: [opt("WEEK"), opt("TWO_WEEKS"), opt("MONTH")],
  });
}

async function confirmPlan(ctx: Ctx, stageId: string, parts: number, every: string) {
  await setPlan(stageId, ctx.user.id, parts, every);
  const p = await savingProgress(stageId);
  const day = (d: Date) => d.toLocaleDateString("en-NG", { weekday: "short", day: "numeric", month: "short", timeZone: "Africa/Lagos" });
  const rows = schedule(p.plan!, p.remaining).map((r, i) => `${i === 0 ? "Now" : day(r.due)}: ${formatNaira(r.amount)}`);
  await ctx.reply(`Plan set ✅\n${rows.join("\n")}\n\nI'll remind you the day before each payment. Paying early or more is always fine.`);
  return payStage(ctx, stageId);
}

async function confirmApprove(ctx: Ctx, stageId: string) {
  const s = await prisma.stage.findUnique({ where: { id: stageId }, include: { deal: { include: { worker: true } } } });
  if (!s || s.deal.clientId !== ctx.user.id) throw new DealError("Only the client can approve");
  if (s.status !== "IN_REVIEW") throw new DealError("This stage isn't waiting for approval");
  return ctx.reply({
    text: `Release ${formatNaira(s.amount)} to ${s.deal.worker.name || "the worker"} for "${s.title}"?\n\nThis can't be undone.`,
    buttons: [
      { id: `approve_yes:${s.id}`, title: "Yes, release" },
      { id: `issue:${s.id}`, title: "Raise an issue" },
      { id: `deal:${s.dealId}`, title: "Not yet" },
    ],
  });
}

async function onIssueReason(ctx: Ctx, text: string) {
  if (!ctx.data.stageId) return menu(ctx);
  await raiseDispute(ctx.data.stageId, ctx.user.id, text);
  await setState(ctx, "IDLE");
  return ctx.reply({
    text: "Issue raised. The money stays locked, and a mediator will contact you both within 5 working days.",
    buttons: [{ id: "deals", title: "My deals" }],
  });
}

async function onDisputeSide(ctx: Ctx, text: string) {
  if (!ctx.data.disputeId) return menu(ctx);
  const disputeId = ctx.data.disputeId;
  await addStatement(disputeId, ctx.user.id, text);
  await setState(ctx, "IDLE");
  kickMediation(disputeId);
  return ctx.reply("Thanks, your side has been recorded. The mediator will look at the evidence and send you both a suggestion shortly.");
}

// ---------- proof photos ----------

async function onMedia(ctx: Ctx, msg: Incoming) {
  let stageId = ctx.state === "AWAIT_PROOF" ? ctx.data.stageId : undefined;
  if (stageId) {
    // The remembered stage may have been paid or disputed since; then look again.
    const remembered = await prisma.stage.findUnique({ where: { id: stageId } });
    if (!remembered || !["FUNDED", "IN_REVIEW"].includes(remembered.status)) stageId = undefined;
  }
  if (!stageId) {
    const open = await prisma.stage.findMany({
      where: { status: { in: ["FUNDED", "IN_REVIEW"] }, deal: { workerId: ctx.user.id, status: "ACTIVE" } },
    });
    if (open.length === 0) {
      return ctx.reply("Thanks for the photo, but none of your deals has a paid stage waiting for proof.");
    }
    if (open.length > 1) {
      return ctx.reply({ text: "Which deal is this photo for? Open the deal first, then send the photo.", buttons: [{ id: "deals", title: "My deals" }] });
    }
    stageId = open[0].id;
  }
  if (!msg.mediaId || !msg.mimeType) throw new DealError("I couldn't read that file. Please send it again.");

  const data = await downloadMedia(msg.mediaId);
  const saved = await saveBuffer(data, msg.mimeType);
  await submitProof(stageId, ctx.user.id, { ...saved, note: msg.caption ?? "" });
  await setState(ctx, "AWAIT_PROOF", { stageId });
  const stage = await prisma.stage.findUniqueOrThrow({ where: { id: stageId }, include: { deal: true } });
  return ctx.reply(
    `Proof added to stage ${stage.position} ("${stage.title}") ✅\nThe client has been asked to review it. If they don't reply within ${stage.deal.reviewHours} hours, you're paid automatically.\n\nSend more photos if you like.`,
  );
}
