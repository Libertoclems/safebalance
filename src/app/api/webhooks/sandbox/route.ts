import { NextResponse } from "next/server";
import { recordIncomingTransfer } from "@/lib/deals";
import { sandboxProvider } from "@/lib/payments/sandbox";
import { dispatchNotifications } from "@/lib/whatsapp/notify";

// Receives "transfer received" notices from the sandbox partner.
// A real partner gets its own route with its own signature check.
export async function POST(req: Request) {
  const raw = await req.text();
  if (!sandboxProvider.verifyWebhook(raw, req.headers)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }
  const transfer = sandboxProvider.parseWebhook(raw);
  if (!transfer) return NextResponse.json({ ok: true, ignored: true });
  const result = await recordIncomingTransfer("sandbox", transfer, raw);
  await dispatchNotifications().catch((e) => console.error("[notify]", e));
  return NextResponse.json({ ok: true, outcome: result.outcome });
}
