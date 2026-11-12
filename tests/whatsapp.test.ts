import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/db";
import { createDeal } from "../src/lib/deals";
import { checkLedger } from "../src/lib/ledger";
import { nairaToKobo } from "../src/lib/money";
import { handleIncoming, parseStages } from "../src/lib/whatsapp/bot";
import { dispatchNotifications } from "../src/lib/whatsapp/notify";
import { storeTestMedia, type Button } from "../src/lib/whatsapp/transport";
import { parseWebhook } from "../src/lib/whatsapp/webhook";

const N = nairaToKobo;
const WORKER = "2348031112222";
const CLIENT = "2348053334444";

async function reset() {
  for (const m of [
    prisma.waMessage, prisma.waConversation, prisma.notification, prisma.ledgerEntry, prisma.ledgerTransaction,
    prisma.payout, prisma.webhookEvent, prisma.rating, prisma.deal, prisma.session, prisma.user,
  ] as unknown as { deleteMany: () => Promise<unknown> }[]) {
    await m.deleteMany();
  }
}

const id = () => `wamid.${crypto.randomUUID()}`;
const say = (from: string, text: string, name = "Tester") => handleIncoming({ from, name, messageId: id(), kind: "text", text });
const tap = (from: string, buttonId: string) => handleIncoming({ from, messageId: id(), kind: "button", buttonId });
async function photo(from: string) {
  const mediaId = await storeTestMedia(Buffer.from("fake-png-bytes"));
  return handleIncoming({ from, messageId: id(), kind: "image", mediaId, mimeType: "image/png", caption: "All fitted" });
}

async function outbox(phone: string) {
  const rows = await prisma.waMessage.findMany({ where: { phone, direction: "OUT" }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => JSON.parse(r.body) as { text: string; buttons?: Button[]; template?: string });
}
async function last(phone: string) {
  return (await outbox(phone)).at(-1)!;
}
function button(msg: { buttons?: Button[] }, startsWith: string) {
  const b = msg.buttons?.find((x) => x.id.startsWith(startsWith));
  if (!b) throw new Error(`No ${startsWith} button in ${JSON.stringify(msg)}`);
  return b.id;
}

beforeEach(reset);

describe("parsing", () => {
  it("reads stages the way people type them", () => {
    const s = parseStages("Materials 200k\nInstallation - ₦250,000\nPainting: 1.5m\nTransport 15000 naira");
    expect(s.map((x) => [x.title, x.amountKobo, x.kind])).toEqual([
      ["Materials", N(200_000), "MATERIALS"],
      ["Installation", N(250_000), "WORK"],
      ["Painting", N(1_500_000), "WORK"],
      ["Transport", N(15_000), "WORK"],
    ]);
    expect(() => parseStages("just some words")).toThrow("couldn't read line 1");
  });

  it("reads Cloud API webhooks and ignores receipts", () => {
    const body = {
      entry: [{
        changes: [
          { value: { statuses: [{ id: "x", status: "read" }] } },
          {
            value: {
              contacts: [{ wa_id: WORKER, profile: { name: "Emeka" } }],
              messages: [
                { from: WORKER, id: "a", type: "text", text: { body: "hi" } },
                { from: WORKER, id: "b", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "new", title: "New deal" } } },
                { from: WORKER, id: "c", type: "image", image: { id: "m1", mime_type: "image/jpeg", caption: "done" } },
                { from: WORKER, id: "d", type: "sticker" },
              ],
            },
          },
        ],
      }],
    };
    const msgs = parseWebhook(body);
    expect(msgs.map((m) => m.kind)).toEqual(["text", "button", "image", "other"]);
    expect(msgs[0]).toMatchObject({ from: WORKER, name: "Emeka", text: "hi" });
    expect(msgs[1].buttonId).toBe("new");
    expect(msgs[2]).toMatchObject({ mediaId: "m1", mimeType: "image/jpeg", caption: "done" });
  });
});

describe("a full deal over WhatsApp", () => {
  it("creates, joins, funds, proves and pays", async () => {
    // Worker creates the deal by chat.
    await say(WORKER, "hi", "Emeka Obi");
    expect((await last(WORKER)).buttons?.map((b) => b.id)).toEqual(["new", "deals", "help"]);
    await tap(WORKER, "new");
    await say(WORKER, "Install kitchen cabinets");
    await say(WORKER, "Materials 200k\nInstallation 250,000");
    expect((await last(WORKER)).text).toContain("Client pays: ₦456,750");
    await tap(WORKER, "create");

    const deal = await prisma.deal.findFirstOrThrow({ include: { stages: { orderBy: { position: "asc" } } } });
    expect(deal.title).toBe("Install kitchen cabinets");
    expect(deal.stages.map((s) => s.kind)).toEqual(["MATERIALS", "WORK"]);
    expect((await last(WORKER)).text).toContain(`JOIN%20${deal.code}`);

    // Client joins with the code and accepts.
    await say(CLIENT, `join ${deal.code}`, "Mrs Adeyemi");
    await tap(CLIENT, button(await last(CLIENT), "accept:"));
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).status).toBe("ACTIVE");
    expect((await outbox(WORKER)).some((m) => m.text.includes("Client accepted"))).toBe(true);

    // Client pays both stages (test-mode transfer).
    for (const _ of [1, 2]) {
      await tap(CLIENT, button(await last(CLIENT), "pay:"));
      expect((await last(CLIENT)).text).toContain("Account number");
      await tap(CLIENT, button(await last(CLIENT), "sim:"));
      await tap(CLIENT, button(await last(CLIENT), "deal:"));
    }
    const stages = await prisma.stage.findMany({ where: { dealId: deal.id }, orderBy: { position: "asc" } });
    expect(stages.map((s) => s.status)).toEqual(["RELEASED", "FUNDED"]);
    expect((await outbox(WORKER)).some((m) => m.text.includes("is locked. The worker can start"))).toBe(true);

    // Worker sends a photo; it lands on the funded stage.
    await photo(WORKER);
    expect((await prisma.stage.findUniqueOrThrow({ where: { id: stages[1].id } })).status).toBe("IN_REVIEW");
    expect(await prisma.proof.count({ where: { stageId: stages[1].id } })).toBe(1);

    // Client is notified with Approve buttons, confirms, and the worker is paid.
    const notice = (await outbox(CLIENT)).find((m) => m.text.includes("Proof submitted"))!;
    await tap(CLIENT, button(notice, "approve:"));
    await tap(CLIENT, button(await last(CLIENT), "approve_yes:"));
    expect((await prisma.stage.findUniqueOrThrow({ where: { id: stages[1].id } })).status).toBe("RELEASED");
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).status).toBe("COMPLETED");
    expect((await checkLedger(prisma)).ok).toBe(true);
    expect(await prisma.notification.count({ where: { status: { not: "SENT" } } })).toBe(0);
  });

  it("lets the client raise an issue instead", async () => {
    const worker = await prisma.user.create({ data: { phone: "+" + WORKER, name: "Emeka" } });
    const deal = await createDeal(worker.id, { title: "Tiling", stages: [{ title: "Tiling", amountKobo: N(100_000) }] });
    await say(CLIENT, `JOIN ${deal.code}`);
    await tap(CLIENT, button(await last(CLIENT), "accept:"));
    await tap(CLIENT, button(await last(CLIENT), "pay:"));
    await tap(CLIENT, button(await last(CLIENT), "sim:"));
    await photo(WORKER);
    const stage = await prisma.stage.findFirstOrThrow({ where: { dealId: deal.id } });
    await tap(CLIENT, `issue:${stage.id}`);
    await say(CLIENT, "Half the tiles are cracked and uneven");
    expect((await prisma.stage.findUniqueOrThrow({ where: { id: stage.id } })).status).toBe("DISPUTED");
    expect((await last(CLIENT)).text).toContain("Issue raised");
  });
});

describe("safety", () => {
  it("handles the same WhatsApp message only once", async () => {
    const msg = { from: WORKER, messageId: "wamid.same", kind: "text" as const, text: "hi" };
    await handleIncoming(msg);
    await handleIncoming(msg);
    expect(await prisma.waMessage.count({ where: { direction: "IN" } })).toBe(1);
    expect((await outbox(WORKER)).length).toBe(1);
  });

  it("refuses button taps for a deal the person is not on", async () => {
    const worker = await prisma.user.create({ data: { phone: "+" + WORKER, name: "Emeka" } });
    const deal = await createDeal(worker.id, { title: "Job", stages: [{ title: "Work", amountKobo: N(30_000) }] });
    await say(CLIENT, `JOIN ${deal.code}`);
    await tap(CLIENT, button(await last(CLIENT), "accept:"));
    await tap(CLIENT, button(await last(CLIENT), "pay:"));
    await tap(CLIENT, button(await last(CLIENT), "sim:"));
    await photo(WORKER);
    const stage = await prisma.stage.findFirstOrThrow({ where: { dealId: deal.id } });

    const stranger = "2348099999999";
    await tap(stranger, `approve_yes:${stage.id}`);
    expect((await last(stranger)).text).toContain("Only the client can approve");
    await tap(stranger, `deal:${deal.id}`);
    expect((await last(stranger)).text).toContain("Only the worker and client");
    expect((await prisma.stage.findUniqueOrThrow({ where: { id: stage.id } })).status).toBe("IN_REVIEW");
  });

  it("uses the approved template outside the 24-hour window", async () => {
    // A web-only worker who has never messaged the bot.
    const worker = await prisma.user.create({ data: { phone: "+" + WORKER, name: "Emeka" } });
    const deal = await createDeal(worker.id, { title: "Job", stages: [{ title: "Work", amountKobo: N(30_000) }] });
    await say(CLIENT, `JOIN ${deal.code}`);
    await tap(CLIENT, button(await last(CLIENT), "accept:"));
    await dispatchNotifications();
    const toWorker = await outbox(WORKER);
    expect(toWorker.at(-1)?.template).toBe("deal_update");
    expect(toWorker.at(-1)?.text).not.toContain("\n");
  });

  it("sends a photo to the right stage even if the chat remembers an old one", async () => {
    const worker = await prisma.user.create({ data: { phone: "+" + WORKER, name: "Emeka" } });
    const deal = await createDeal(worker.id, {
      title: "Job",
      stages: [{ title: "First", amountKobo: N(30_000) }, { title: "Second", amountKobo: N(30_000) }],
    });
    await say(CLIENT, `JOIN ${deal.code}`);
    await tap(CLIENT, button(await last(CLIENT), "accept:"));
    await tap(CLIENT, button(await last(CLIENT), "pay:"));
    await tap(CLIENT, button(await last(CLIENT), "sim:"));
    await photo(WORKER); // chat now remembers stage 1
    const [first, second] = await prisma.stage.findMany({ where: { dealId: deal.id }, orderBy: { position: "asc" } });
    await tap(CLIENT, `approve_yes:${first.id}`);
    await tap(CLIENT, `deal:${deal.id}`);
    await tap(CLIENT, button(await last(CLIENT), "pay:"));
    await tap(CLIENT, button(await last(CLIENT), "sim:"));

    await photo(WORKER); // must land on stage 2, not the paid stage 1
    expect((await prisma.stage.findUniqueOrThrow({ where: { id: second.id } })).status).toBe("IN_REVIEW");
    expect((await last(WORKER)).text).toContain("Proof added to stage 2");
  });

  it("explains a bad stage list instead of failing", async () => {
    await tap(WORKER, "new");
    await say(WORKER, "Fix the roof");
    await say(WORKER, "roof work and painting");
    expect((await last(WORKER)).text).toContain("couldn't read line 1");
    expect(await prisma.deal.count()).toBe(0);
  });
});
