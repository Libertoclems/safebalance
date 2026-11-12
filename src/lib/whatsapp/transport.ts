import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../db";

// Sending WhatsApp messages. Two transports:
//   cloud - Meta's WhatsApp Cloud API (needs WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID)
//   test  - nothing leaves the server; messages are stored for the phone simulator
// Every message, in or out, is also written to WaMessage for audit.

export type Button = { id: string; title: string };
export type OutMessage = { text: string; buttons?: Button[] };

const MAX_BUTTONS = 3; // WhatsApp limit for reply buttons
const MAX_TITLE = 20; // WhatsApp limit for a button title
const MAX_TEXT = 4096;
const MAX_INTERACTIVE_TEXT = 1024;

export function whatsappMode(): "cloud" | "test" {
  return process.env.WHATSAPP_MODE === "cloud" ? "cloud" : "test";
}

/** The bot's own number (digits only), used for wa.me links. */
export function botNumber() {
  return (process.env.WHATSAPP_BOT_NUMBER ?? "2340000000000").replace(/\D/g, "");
}

export function waLink(text: string) {
  return `https://wa.me/${botNumber()}?text=${encodeURIComponent(text)}`;
}

/** Trim a message to fit WhatsApp's limits. */
export function fitToLimits(msg: OutMessage): OutMessage {
  const buttons = msg.buttons?.slice(0, MAX_BUTTONS).map((b) => ({ id: b.id, title: b.title.slice(0, MAX_TITLE) }));
  const limit = buttons?.length ? MAX_INTERACTIVE_TEXT : MAX_TEXT;
  const text = msg.text.length > limit ? msg.text.slice(0, limit - 1) + "…" : msg.text;
  return { text, buttons: buttons?.length ? buttons : undefined };
}

function graphUrl(p: string) {
  const version = process.env.WHATSAPP_API_VERSION ?? "v21.0";
  return `https://graph.facebook.com/${version}/${p}`;
}

async function graph(p: string, body: unknown) {
  const res = await fetch(graphUrl(p), {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${await res.text()}`);
  return res.json();
}

function cloudPayload(to: string, msg: OutMessage) {
  if (!msg.buttons) return { messaging_product: "whatsapp", to, type: "text", text: { body: msg.text, preview_url: true } };
  return {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: msg.text },
      action: { buttons: msg.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
    },
  };
}

/** Send a message to a WhatsApp number (digits only). */
export async function sendMessage(to: string, message: OutMessage) {
  const msg = fitToLimits(message);
  await prisma.waMessage.create({ data: { phone: to, direction: "OUT", body: JSON.stringify(msg) } });
  if (whatsappMode() === "test") return;
  await graph(`${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, cloudPayload(to, msg));
}

/**
 * Business-started message outside the 24-hour window. WhatsApp only allows
 * pre-approved templates here; we use one template, "deal_update", whose body
 * is "SafeBalance update: {{1}}". Template values can't contain line breaks.
 */
export async function sendTemplate(to: string, text: string) {
  const flat = text.replace(/\s*\n+\s*/g, " · ").replace(/\s{4,}/g, " ").slice(0, 900);
  await prisma.waMessage.create({ data: { phone: to, direction: "OUT", body: JSON.stringify({ text: flat, template: "deal_update" }) } });
  if (whatsappMode() === "test") return;
  await graph(`${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: process.env.WHATSAPP_TEMPLATE ?? "deal_update",
      language: { code: "en" },
      components: [{ type: "body", parameters: [{ type: "text", text: flat }] }],
    },
  });
}

// ---------- incoming media ----------

const TEST_MEDIA_DIR = path.join(process.cwd(), "uploads", "wa-test-media");

/** Test mode: keep a simulator upload so the bot can "download" it like Cloud API media. */
export async function storeTestMedia(data: Buffer) {
  await fs.mkdir(TEST_MEDIA_DIR, { recursive: true });
  const id = "test_" + crypto.randomBytes(12).toString("hex");
  await fs.writeFile(path.join(TEST_MEDIA_DIR, id), data);
  return id;
}

/** Download a photo or video someone sent the bot. */
export async function downloadMedia(mediaId: string): Promise<Buffer> {
  if (whatsappMode() === "test") {
    return fs.readFile(path.join(TEST_MEDIA_DIR, path.basename(mediaId)));
  }
  const auth = { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
  const meta = await fetch(graphUrl(mediaId), { headers: auth });
  if (!meta.ok) throw new Error(`Media lookup failed: ${meta.status}`);
  const { url } = (await meta.json()) as { url: string };
  const file = await fetch(url, { headers: auth });
  if (!file.ok) throw new Error(`Media download failed: ${file.status}`);
  return Buffer.from(await file.arrayBuffer());
}

// ---------- webhook signature ----------

/** Meta signs each webhook with the app secret: header X-Hub-Signature-256 = "sha256=<hex>". */
export function verifySignature(rawBody: string, header: string | null) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = header.slice(7);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
