import { handleIncoming, type Incoming } from "./bot";

// Shapes of the WhatsApp Cloud API webhook we read. Anything else is ignored.
type WaWebhook = {
  object?: string;
  entry?: {
    changes?: {
      field?: string;
      value?: {
        contacts?: { wa_id: string; profile?: { name?: string } }[];
        messages?: {
          from: string;
          id: string;
          type: string;
          text?: { body: string };
          interactive?: { type: string; button_reply?: { id: string; title: string }; list_reply?: { id: string } };
          button?: { payload?: string; text?: string };
          image?: { id: string; mime_type: string; caption?: string };
          video?: { id: string; mime_type: string; caption?: string };
        }[];
      };
    }[];
  }[];
};

/** Turn a webhook body into the messages the bot understands. */
export function parseWebhook(body: WaWebhook): Incoming[] {
  const out: Incoming[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value?.messages) continue; // delivery/read receipts etc.
      const names = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of value.messages) {
        const base = { from: m.from, name: names.get(m.from), messageId: m.id };
        if (m.type === "text" && m.text) {
          out.push({ ...base, kind: "text", text: m.text.body });
        } else if (m.type === "interactive" && m.interactive) {
          const id = m.interactive.button_reply?.id ?? m.interactive.list_reply?.id;
          out.push({ ...base, kind: "button", buttonId: id });
        } else if (m.type === "button" && m.button) {
          // Quick-reply button on a template message: treat its text as typed text.
          out.push({ ...base, kind: "text", text: m.button.text ?? m.button.payload ?? "" });
        } else if (m.type === "image" && m.image) {
          out.push({ ...base, kind: "image", mediaId: m.image.id, mimeType: m.image.mime_type, caption: m.image.caption });
        } else if (m.type === "video" && m.video) {
          out.push({ ...base, kind: "video", mediaId: m.video.id, mimeType: m.video.mime_type, caption: m.video.caption });
        } else {
          out.push({ ...base, kind: "other" });
        }
      }
    }
  }
  return out;
}

export async function processWebhook(body: unknown) {
  const messages = parseWebhook(body as WaWebhook);
  for (const m of messages) await handleIncoming(m);
  return messages.length;
}
