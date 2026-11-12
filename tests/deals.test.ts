import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/db";
import {
  acceptDeal, addChangeOrder, approveStage, autoReleaseDue, cancelDeal, createDeal, DealError,
  prepareFunding, raiseDispute, rateDeal, recordIncomingTransfer, resolveDispute, respondChangeOrder, submitProof,
} from "../src/lib/deals";
import { ACCOUNTS, checkLedger, held } from "../src/lib/ledger";
import { nairaToKobo, stageFee } from "../src/lib/money";

const N = nairaToKobo;

async function reset() {
  await prisma.ledgerEntry.deleteMany();
  await prisma.ledgerTransaction.deleteMany();
  await prisma.payout.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.rating.deleteMany();
  await prisma.deal.deleteMany();
  await prisma.user.deleteMany();
}

async function user(name: string, withBank = true) {
  return prisma.user.create({
    data: {
      phone: "+23480" + crypto.randomInt(10_000_000, 99_999_999),
      name,
      idVerified: withBank,
      ...(withBank ? { bankName: "Test Bank", bankAccountNumber: "0123456789", bankAccountName: name } : {}),
    },
  });
}

/** Simulate the client's bank transfer for a stage. */
async function fund(stageId: string, clientId: string, amountOverride?: number, eventId: string = crypto.randomUUID()) {
  const s = await prepareFunding(stageId, clientId);
  return recordIncomingTransfer("sandbox", { eventId, reference: s.paymentRef!, amountKobo: amountOverride ?? s.amount + s.fee }, "{}");
}

async function setup(stages = [{ title: "Materials", amountKobo: N(200_000), kind: "MATERIALS" as const }, { title: "Installation", amountKobo: N(250_000) }]) {
  const worker = await user("Emeka");
  const client = await user("Mrs Adeyemi");
  const deal = await createDeal(worker.id, { title: "Kitchen cabinets", stages });
  await acceptDeal(deal.id, client.id);
  const ss = await prisma.stage.findMany({ where: { dealId: deal.id }, orderBy: { position: "asc" } });
  return { worker, client, deal, stages: ss };
}

async function expectBalanced() {
  const check = await checkLedger(prisma);
  expect(check.unbalanced).toEqual([]);
  expect(check.ok).toBe(true);
  return check;
}

beforeEach(reset);

describe("happy path", () => {
  it("locks, releases and pays out each stage", async () => {
    const { worker, client, deal, stages } = await setup();
    const [materials, install] = stages;

    // Materials stage is released the moment it is funded.
    expect((await fund(materials.id, client.id)).outcome).toBe("funded");
    expect((await prisma.stage.findUnique({ where: { id: materials.id } }))!.status).toBe("RELEASED");

    await fund(install.id, client.id);
    await submitProof(install.id, worker.id, { filePath: "x.jpg", mimeType: "image/jpeg" });
    const inReview = await prisma.stage.findUnique({ where: { id: install.id } });
    expect(inReview!.status).toBe("IN_REVIEW");
    expect(inReview!.reviewDeadline!.getTime()).toBeGreaterThan(Date.now() + 71 * 3600_000);

    await approveStage(install.id, client.id);

    const done = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(done!.status).toBe("COMPLETED");

    // Worker was paid both stages; nothing left owed or locked.
    const payouts = await prisma.payout.findMany({ where: { userId: worker.id, status: "SUCCESS" } });
    expect(payouts.reduce((s, p) => s + p.amount, 0)).toBe(N(450_000));
    expect(await held(prisma, ACCOUNTS.userPayable(worker.id))).toBe(0);

    const check = await expectBalanced();
    expect(check.fees).toBe(stageFee(N(200_000)) + stageFee(N(250_000)));
    expect(check.lockedInEscrow).toBe(0);
    expect(check.clearing).toBe(check.fees); // only our fees remain at the partner
  });

  it("pays a materials supplier directly when one is given", async () => {
    const { client, stages } = await setup([
      { title: "Cement", amountKobo: N(80_000), kind: "MATERIALS", supplierName: "Dangote Depot", supplierBank: "Test Bank", supplierAcct: "1112223334" } as never,
      { title: "Labour", amountKobo: N(50_000) },
    ]);
    await fund(stages[0].id, client.id);
    const p = await prisma.payout.findFirst({ where: { stageId: stages[0].id } });
    expect(p).toMatchObject({ recipientName: "Dangote Depot", amount: N(80_000), status: "SUCCESS" });
    await expectBalanced();
  });

  it("holds money until the worker adds bank details", async () => {
    const worker = await user("New worker", false);
    const client = await user("Client");
    const deal = await createDeal(worker.id, { title: "Logo", stages: [{ title: "Logo design", amountKobo: N(60_000) }] });
    await acceptDeal(deal.id, client.id);
    const [s] = await prisma.stage.findMany({ where: { dealId: deal.id } });
    await fund(s.id, client.id);
    await submitProof(s.id, worker.id, { filePath: "x", mimeType: "image/png" });
    await approveStage(s.id, client.id);
    expect(await held(prisma, ACCOUNTS.userPayable(worker.id))).toBe(N(60_000));
    expect(await prisma.payout.count()).toBe(0);
  });
});

describe("guards", () => {
  it("makes the client fund stages in order", async () => {
    const { client, stages } = await setup([{ title: "A", amountKobo: N(10_000) }, { title: "B", amountKobo: N(10_000) }]);
    await expect(prepareFunding(stages[1].id, client.id)).rejects.toThrow("earlier stages");
  });

  it("ignores the same bank notification twice", async () => {
    const { client, stages } = await setup([{ title: "A", amountKobo: N(30_000) }]);
    const first = await fund(stages[0].id, client.id, undefined, "evt-1");
    const again = await recordIncomingTransfer("sandbox",
      { eventId: "evt-1", reference: `stg_${stages[0].id}`, amountKobo: N(30_000) + stageFee(N(30_000)) }, "{}");
    expect(first.outcome).toBe("funded");
    expect(again.outcome).toBe("duplicate");
    const check = await expectBalanced();
    expect(check.lockedInEscrow).toBe(N(30_000) + stageFee(N(30_000)));
  });

  it("treats a short transfer as a part payment, and money for a paid stage as unmatched", async () => {
    const { client, stages } = await setup([{ title: "A", amountKobo: N(30_000) }]);
    const r = await fund(stages[0].id, client.id, N(29_000));
    expect(r.outcome).toBe("partial");
    expect((await prisma.stage.findUnique({ where: { id: stages[0].id } }))!.status).toBe("PARTLY_FUNDED");

    await fund(stages[0].id, client.id, N(30_000) + stageFee(N(30_000)) - N(29_000));
    expect((await prisma.stage.findUnique({ where: { id: stages[0].id } }))!.status).toBe("FUNDED");

    // A stray transfer to the account of a stage that's already paid.
    const late = await recordIncomingTransfer("sandbox",
      { eventId: crypto.randomUUID(), reference: `stg_${stages[0].id}`, amountKobo: N(5_000) }, "{}");
    expect(late.outcome).toBe("suspense");
    const check = await expectBalanced();
    expect(check.suspense).toBe(N(5_000));
  });

  it("can't release the same stage twice", async () => {
    const { worker, client, stages } = await setup([{ title: "A", amountKobo: N(30_000) }, { title: "B", amountKobo: N(30_000) }]);
    await fund(stages[0].id, client.id);
    await submitProof(stages[0].id, worker.id, { filePath: "x", mimeType: "image/png" });
    const results = await Promise.allSettled([approveStage(stages[0].id, client.id), approveStage(stages[0].id, client.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const paid = await prisma.payout.findMany({ where: { userId: worker.id } });
    expect(paid.reduce((s, p) => s + p.amount, 0)).toBe(N(30_000));
    await expectBalanced();
  });

  it("only lets the right person act", async () => {
    const { worker, client, stages } = await setup([{ title: "A", amountKobo: N(30_000) }]);
    await expect(prepareFunding(stages[0].id, worker.id)).rejects.toBeInstanceOf(DealError);
    await fund(stages[0].id, client.id);
    await expect(submitProof(stages[0].id, client.id, { filePath: "x", mimeType: "image/png" })).rejects.toBeInstanceOf(DealError);
    await submitProof(stages[0].id, worker.id, { filePath: "x", mimeType: "image/png" });
    await expect(approveStage(stages[0].id, worker.id)).rejects.toBeInstanceOf(DealError);
  });
});

describe("auto-release", () => {
  it("pays the worker when the client stays silent past the window", async () => {
    const { worker, client, stages } = await setup([{ title: "Wiring", amountKobo: N(120_000) }]);
    await fund(stages[0].id, client.id);
    await submitProof(stages[0].id, worker.id, { filePath: "x", mimeType: "image/png" });

    expect(await autoReleaseDue()).toBe(0); // not yet
    expect(await autoReleaseDue(new Date(Date.now() + 73 * 3600_000))).toBe(1);
    expect((await prisma.stage.findUnique({ where: { id: stages[0].id } }))!.status).toBe("RELEASED");
    await expectBalanced();
  });
});

describe("disputes", () => {
  it("splits the money as decided, with the fee charged only on the worker's share", async () => {
    const { worker, client, stages } = await setup([{ title: "Tiling", amountKobo: N(100_000) }]);
    await fund(stages[0].id, client.id);
    await submitProof(stages[0].id, worker.id, { filePath: "x", mimeType: "image/png" });
    await raiseDispute(stages[0].id, client.id, "Half the tiles are cracked and uneven");

    // Auto-release must not touch a disputed stage.
    expect(await autoReleaseDue(new Date(Date.now() + 100 * 3600_000))).toBe(0);

    const d = await prisma.dispute.findFirstOrThrow({ where: { stageId: stages[0].id } });
    await resolveDispute(d.id, "admin", N(60_000), "Worker re-does 4 tiles at own cost");

    const fee = stageFee(N(100_000));
    const workerPaid = await prisma.payout.findFirstOrThrow({ where: { userId: worker.id } });
    const clientRefund = await prisma.payout.findFirstOrThrow({ where: { userId: client.id } });
    expect(workerPaid.amount).toBe(N(60_000));
    expect(clientRefund.amount).toBe(N(40_000) + fee - Math.round(fee * 0.6));
    expect((await prisma.stage.findUnique({ where: { id: stages[0].id } }))!.status).toBe("SPLIT");
    await expectBalanced();
  });
});

describe("change orders and cancelling", () => {
  it("adds extra work only when the client accepts", async () => {
    const { worker, client, deal, stages } = await setup([{ title: "Paint", amountKobo: N(50_000) }]);
    await addChangeOrder(deal.id, worker.id, { title: "Paint the gate", amountKobo: N(15_000) });
    const extra = await prisma.stage.findFirstOrThrow({ where: { dealId: deal.id, isChangeOrder: true } });
    expect(extra.status).toBe("PENDING_APPROVAL");
    await expect(prepareFunding(extra.id, client.id)).rejects.toThrow();
    await respondChangeOrder(extra.id, client.id, true);
    await fund(stages[0].id, client.id);
    expect((await fund(extra.id, client.id)).outcome).toBe("funded");
  });

  it("refunds the client when the worker cancels mid-job", async () => {
    const { worker, client, deal, stages } = await setup([{ title: "A", amountKobo: N(40_000) }, { title: "B", amountKobo: N(40_000) }]);
    await fund(stages[0].id, client.id);
    await cancelDeal(deal.id, worker.id, "Travelling");
    const refund = await prisma.payout.findFirstOrThrow({ where: { userId: client.id } });
    expect(refund.amount).toBe(N(40_000) + stageFee(N(40_000)));
    expect((await prisma.deal.findUnique({ where: { id: deal.id } }))!.status).toBe("CANCELLED");
    await expectBalanced();
  });

  it("stops the client cancelling while money is locked", async () => {
    const { client, deal, stages } = await setup([{ title: "A", amountKobo: N(40_000) }]);
    await fund(stages[0].id, client.id);
    await expect(cancelDeal(deal.id, client.id, "")).rejects.toThrow("Raise an issue");
  });
});

describe("payout failures", () => {
  it("puts the money back when the bank transfer fails", async () => {
    const worker = await prisma.user.create({
      data: { phone: "+2348011112222", name: "W", idVerified: true, bankName: "Test Bank", bankAccountNumber: "1234567000" },
    });
    const client = await user("C");
    const deal = await createDeal(worker.id, { title: "Job", stages: [{ title: "Work", amountKobo: N(20_000) }] });
    await acceptDeal(deal.id, client.id);
    const [s] = await prisma.stage.findMany({ where: { dealId: deal.id } });
    await fund(s.id, client.id);
    await submitProof(s.id, worker.id, { filePath: "x", mimeType: "image/png" });
    await approveStage(s.id, client.id);
    expect((await prisma.payout.findFirstOrThrow({ where: { userId: worker.id } })).status).toBe("FAILED");
    expect(await held(prisma, ACCOUNTS.userPayable(worker.id))).toBe(N(20_000));
    await expectBalanced();
  });
});

describe("ratings", () => {
  it("lets each side rate once after the deal closes", async () => {
    const { worker, client, deal, stages } = await setup([{ title: "A", amountKobo: N(20_000) }]);
    await expect(rateDeal(deal.id, client.id, 5, "")).rejects.toThrow("closed");
    await fund(stages[0].id, client.id);
    await submitProof(stages[0].id, worker.id, { filePath: "x", mimeType: "image/png" });
    await approveStage(stages[0].id, client.id);
    await rateDeal(deal.id, client.id, 5, "Neat work");
    await rateDeal(deal.id, worker.id, 4, "Paid on time");
    await expect(rateDeal(deal.id, client.id, 1, "")).rejects.toThrow("already");
  });
});
