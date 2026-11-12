import { prisma } from "../db";
import { sendMessage, sendTemplate, type Button } from "./transport";

const WINDOW_MS = 24 * 3600_000;

export function waIdFromPhone(phone: string) {
  return phone.replace(/\D/g, ""); // "+2348031112222" -> "2348031112222"
}

let running: Promise<number> | null = null;

/**
 * Send queued deal updates. Inside WhatsApp's 24-hour window (the person
 * messaged the bot recently) we send a normal message with buttons; outside
 * it, WhatsApp only allows the approved "deal_update" template.
 */
export function dispatchNotifications(): Promise<number> {
  if (!running) running = dispatch().finally(() => (running = null));
  return running;
}

async function dispatch() {
  const pending = await prisma.notification.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, take: 50 });
  let sent = 0;
  for (const n of pending) {
    try {
      const user = await prisma.user.findUnique({ where: { id: n.userId } });
      if (!user) throw new Error("user not found");
      const to = waIdFromPhone(user.phone);
      const convo = await prisma.waConversation.findUnique({ where: { phone: to } });
      const inWindow = !!convo?.lastInboundAt && Date.now() - convo.lastInboundAt.getTime() < WINDOW_MS;
      if (inWindow) {
        await sendMessage(to, { text: n.text, buttons: n.buttons ? (JSON.parse(n.buttons) as Button[]) : undefined });
      } else {
        await sendTemplate(to, n.text);
      }
      await prisma.notification.update({ where: { id: n.id }, data: { status: "SENT", sentAt: new Date() } });
      sent++;
    } catch (e) {
      await prisma.notification.update({
        where: { id: n.id },
        data: { status: "FAILED", attempts: { increment: 1 }, error: String(e).slice(0, 500) },
      });
    }
  }
  return sent;
}
