"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { storeTestMedia, whatsappMode } from "@/lib/whatsapp/transport";
import { processWebhook } from "@/lib/whatsapp/webhook";

// Test-mode phone simulator: builds the same webhook body Meta would send and
// runs it through the real parser and bot.

function guard() {
  if (whatsappMode() !== "test") throw new Error("The simulator only works in test mode");
}

function webhookBody(from: string, name: string, message: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        field: "messages",
        value: {
          contacts: [{ wa_id: from, profile: { name } }],
          messages: [{ from, id: `wamid.sim_${crypto.randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
        },
      }],
    }],
  };
}

const field = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const digits = (s: string) => s.replace(/\D/g, "");

export async function simSendText(fd: FormData) {
  guard();
  const text = field(fd, "text");
  if (!text) return;
  await processWebhook(webhookBody(digits(field(fd, "phone")), field(fd, "name"), { type: "text", text: { body: text } }));
  revalidatePath("/dev/whatsapp");
}

export async function simTapButton(fd: FormData) {
  guard();
  await processWebhook(
    webhookBody(digits(field(fd, "phone")), field(fd, "name"), {
      type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: field(fd, "buttonId"), title: field(fd, "title") } },
    }),
  );
  revalidatePath("/dev/whatsapp");
}

export async function simSendPhoto(fd: FormData) {
  guard();
  const file = fd.get("file") as File | null;
  if (!file || file.size === 0) return;
  const mediaId = await storeTestMedia(Buffer.from(await file.arrayBuffer()));
  const kind = file.type.startsWith("video/") ? "video" : "image";
  await processWebhook(
    webhookBody(digits(field(fd, "phone")), field(fd, "name"), {
      type: kind,
      [kind]: { id: mediaId, mime_type: file.type, caption: field(fd, "caption") || undefined },
    }),
  );
  revalidatePath("/dev/whatsapp");
}
