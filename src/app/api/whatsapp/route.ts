import { NextResponse } from "next/server";
import { verifySignature, whatsappMode } from "@/lib/whatsapp/transport";
import { processWebhook } from "@/lib/whatsapp/webhook";

// WhatsApp Cloud API webhook. Set the callback URL in the Meta app to
// https://<your domain>/api/whatsapp and the verify token to WHATSAPP_VERIFY_TOKEN.

/** Meta calls this once to confirm we own the URL. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const ok =
    url.searchParams.get("hub.mode") === "subscribe" &&
    !!process.env.WHATSAPP_VERIFY_TOKEN &&
    url.searchParams.get("hub.verify_token") === process.env.WHATSAPP_VERIFY_TOKEN;
  if (!ok) return new NextResponse("forbidden", { status: 403 });
  return new NextResponse(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
}

/** Incoming messages. Only accepted with a valid Meta signature (cloud mode). */
export async function POST(req: Request) {
  if (whatsappMode() !== "cloud") return NextResponse.json({ error: "WhatsApp is in test mode" }, { status: 404 });
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }
  try {
    await processWebhook(JSON.parse(raw));
  } catch (e) {
    // Still answer 200: a failure here would make Meta retry the same message.
    console.error("[whatsapp] webhook failed", e);
  }
  return NextResponse.json({ ok: true });
}
