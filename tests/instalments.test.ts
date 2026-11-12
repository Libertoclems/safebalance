import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/db";
import { acceptDeal, cancelDeal, createDeal, prepareFunding, recordIncomingTransfer, submitProof, type NewStage } from "../src/lib/deals";
import { cancelPlan, savingProgress, schedule, sendInstalmentReminders, setPlan } from "../src/lib/instalments";
import { checkLedger, held, ACCOUNTS } from "../src/lib/ledger";
import { nairaToKobo, stageFee } from "../src/lib/money";
import { handleIncoming } from "../src/lib/whatsapp/bot";
import type { Button } from "../src/lib/whatsapp/transport";

const N = nairaToKobo;
const DAY = 24 * 3600_000;

async function reset() {
  for (const m of [
    prisma.waMessage, prisma.waConversation, prisma.notification, prisma.ledgerEntry, prisma.ledgerTransaction,
    prisma.payout, prisma.webhookEvent, prisma.rating, prisma.deal, prisma.session, prisma.user,
  ] as unknown as { deleteMany: () => Promise<unknown> }[]) {
    await m.deleteMany();
  }
}

const phone = () => "+23480" + crypto.randomInt(10_000_000, 99_999_999);
const bank = { idVerified: true, bankName: "Test Bank", bankAccountNumber: "0123456789" };

async function setup(stages: NewStage[] = [{ title: "Wiring", amountKobo: N(200_000) }]) {
  const worker = await prisma.user.create({ data: { phone: phone(), name: "Emeka", ...bank } });
  const client = await prisma.user.create({ data: { phone: phone(), name: "Mrs Adeyemi", ...bank } });
  const deal = await createDeal(worker.id, { title: "Flat", stages });
  await acceptDeal(deal.id, client.id);
  const ss = await prisma.stage.findMany({ where: { dealId: deal.id }, orderBy: { position: "asc" } });
  return { worker, client, deal, stages: ss };
}

async function pay(stageId: string, clientId: string, amountKobo: number) {
  const s = await prepareFunding(stageId, clientId);
  return recordIncomingTransfer("sandbox", { eventId: crypto.randomUUID(), reference: s.paymentRef!, amountKobo }, "{}");
}
const status = async (id: string) => (await prisma.stage.findUniqueOrThrow({ where: { id } })).status;

beforeEach(reset);

describe("paying in parts", () => {
  it("locks each part and lets work start only when fully paid", async () => {
    const { worker, client, stages } = await setup();
    const s = stages[0];
    const target = N(200_000) + stageFee(N(200_000)); // ₦203,000

    expect((await pay(s.id, client.id, N(50_000))).outcome).toBe("partial");
    expect(await status(s.id)).toBe("PARTLY_FUNDED");
    await expect(submitProof(s.id, worker.id, { filePath: "x", mimeType: "image/png" })).rejects.toThrow("funded stage");

    await pay(s.id, client.id, N(100_000));
    const p = await savingProgress(s.id);
    expect(p).toMatchObject({ saved: N(150_000), remaining: target - N(150_000), percent: 73 });

    expect((await pay(s.id, client.id, target - N(150_000))).outcome).toBe("funded");
    expect(await status(s.id)).toBe("FUNDED");
    expect(await held(prisma, ACCOUNTS.escrow(s.id))).toBe(target);

    // Both sides were told about each part; the worker only told to start at the end.
    const toWorker = await prisma.notification.findMany({ where: { userId: worker.id }, orderBy: { createdAt: "asc" } });
    expect(toWorker.filter((n) => n.text.includes("Part payment"))).toHaveLength(2);
    expect(toWorker.at(-1)!.text).toContain("The worker can start");
    expect((await checkLedger(prisma)).ok).toBe(true);
  });

  it("refunds anything paid beyond what's needed", async () => {
    const { client, stages } = await setup([{ title: "Tiling", amountKobo: N(100_000) }]);
    const target = N(100_000) + stageFee(N(100_000));
    await pay(stages[0].id, client.id, N(60_000));
    await pay(stages[0].id, client.id, N(60_000)); // ₦18,500 too much
    expect(await status(stages[0].id)).toBe("FUNDED");
    const refund = await prisma.payout.findFirstOrThrow({ where: { userId: client.id } });
    expect(refund.amount).toBe(N(120_000) - target);
    expect((await checkLedger(prisma)).ok).toBe(true);
  });

  it("releases a materials stage only once it's fully paid", async () => {
    const { worker, client, stages } = await setup([{ title: "Materials", amountKobo: N(50_000), kind: "MATERIALS" }]);
    await pay(stages[0].id, client.id, N(20_000));
    expect(await status(stages[0].id)).toBe("PARTLY_FUNDED");
    expect(await prisma.payout.count({ where: { userId: worker.id } })).toBe(0);
    await pay(stages[0].id, client.id, N(50_000) + stageFee(N(50_000)) - N(20_000));
    expect(await status(stages[0].id)).toBe("RELEASED");
  });

  it("gives saved money back if the deal is cancelled before work starts", async () => {
    const { client, deal, stages } = await setup();
    await pay(stages[0].id, client.id, N(70_000));
    await cancelDeal(deal.id, client.id, "Changed my mind"); // allowed: no work has started
    expect(await status(stages[0].id)).toBe("REFUNDED");
    const refund = await prisma.payout.findFirstOrThrow({ where: { userId: client.id } });
    expect(refund.amount).toBe(N(70_000));
    expect((await checkLedger(prisma)).ok).toBe(true);
  });

  it("still makes the client pay stages in order", async () => {
    const { client, stages } = await setup([{ title: "A", amountKobo: N(40_000) }, { title: "B", amountKobo: N(40_000) }]);
    await pay(stages[0].id, client.id, N(10_000));
    await expect(prepareFunding(stages[1].id, client.id)).rejects.toThrow("earlier stages");
    await expect(setPlan(stages[1].id, client.id, 4, "WEEK")).rejects.toThrow("earlier stages");
  });
});

describe("plans and reminders", () => {
  it("splits what's left into parts and schedules them", async () => {
    const { client, stages } = await setup();
    await pay(stages[0].id, client.id, N(3_000)); // ₦200,000 left
    const r = await setPlan(stages[0].id, client.id, 4, "WEEK");
    expect(r.instalment).toBe(N(50_000));
    const p = await savingProgress(stages[0].id);
    const rows = schedule(p.plan!, p.remaining);
    expect(rows.map((x) => x.amount)).toEqual([N(50_000), N(50_000), N(50_000), N(50_000)]);
    expect(rows[1].due.getTime() - rows[0].due.getTime()).toBe(7 * DAY);
  });

  it("rejects bad plans and plans by anyone but the client", async () => {
    const { worker, client, stages } = await setup();
    await expect(setPlan(stages[0].id, client.id, 1, "WEEK")).rejects.toThrow("between 2 and 12");
    await expect(setPlan(stages[0].id, client.id, 4, "DAILY")).rejects.toThrow("how often");
    await expect(setPlan(stages[0].id, worker.id, 4, "WEEK")).rejects.toThrow("Only the client");
  });

  it("reminds the day before, once, and nudges once when late", async () => {
    const { client, stages } = await setup();
    await setPlan(stages[0].id, client.id, 4, "WEEK");
    await pay(stages[0].id, client.id, (await savingProgress(stages[0].id)).nextAmount); // first part now
    const plan = await prisma.instalmentPlan.findUniqueOrThrow({ where: { stageId: stages[0].id } });
    const due = plan.nextDueAt.getTime();
    expect(due).toBeGreaterThan(Date.now() + 6 * DAY); // moved on a week

    expect(await sendInstalmentReminders(new Date(due - 3 * DAY))).toBe(0); // too early
    expect(await sendInstalmentReminders(new Date(due - 12 * 3600_000))).toBe(1); // day before
    expect(await sendInstalmentReminders(new Date(due - 6 * 3600_000))).toBe(0); // not twice
    expect(await sendInstalmentReminders(new Date(due + 4 * DAY))).toBe(1); // late nudge
    expect(await sendInstalmentReminders(new Date(due + 5 * DAY))).toBe(0);

    const reminders = await prisma.notification.findMany({
      where: { userId: client.id, text: { contains: "Pay to" } },
      orderBy: { createdAt: "asc" },
    });
    expect(reminders).toHaveLength(2);
    expect(reminders[1].text).toContain("was due");
    expect(reminders[0].text).toContain("Reminder");
    expect(reminders[0].buttons).toContain(`pay:${stages[0].id}`);
  });

  it("stops reminding once the stage is paid or the plan is stopped", async () => {
    const { client, stages } = await setup([{ title: "A", amountKobo: N(40_000) }, { title: "B", amountKobo: N(40_000) }]);
    await setPlan(stages[0].id, client.id, 2, "WEEK");
    await pay(stages[0].id, client.id, N(40_000) + stageFee(N(40_000)));
    expect((await prisma.instalmentPlan.findFirstOrThrow()).active).toBe(false);
    expect(await sendInstalmentReminders(new Date(Date.now() + 30 * DAY))).toBe(0);

    await setPlan(stages[1].id, client.id, 2, "MONTH");
    await cancelPlan(stages[1].id, client.id);
    expect(await sendInstalmentReminders(new Date(Date.now() + 60 * DAY))).toBe(0);
  });
});

describe("over WhatsApp", () => {
  it("sets up a plan with two taps and shows progress", async () => {
    const { client, deal, stages } = await setup();
    const from = client.phone.replace("+", "");
    const tap = (buttonId: string) => handleIncoming({ from, messageId: `wamid.${crypto.randomUUID()}`, kind: "button", buttonId });
    const last = async () => {
      const m = await prisma.waMessage.findFirstOrThrow({ where: { phone: from, direction: "OUT" }, orderBy: { createdAt: "desc" } });
      return JSON.parse(m.body) as { text: string; buttons?: Button[] };
    };

    await tap(`pay:${stages[0].id}`);
    expect((await last()).buttons?.map((b) => b.id)).toContain(`plan:${stages[0].id}`);
    await tap(`plan:${stages[0].id}`);
    await tap(`planparts:${stages[0].id}:4`);
    await tap(`planevery:${stages[0].id}:4:TWO_WEEKS`);
    const plan = await prisma.instalmentPlan.findUniqueOrThrow({ where: { stageId: stages[0].id } });
    expect(plan).toMatchObject({ parts: 4, every: "TWO_WEEKS", instalment: N(50_750) });

    await tap(`sim:${stages[0].id}`); // pays the next part
    expect(await status(stages[0].id)).toBe("PARTLY_FUNDED");
    await tap(`deal:${deal.id}`);
    expect((await last()).text).toContain("₦50,750 of ₦203,000 saved (25%)");
  });
});
