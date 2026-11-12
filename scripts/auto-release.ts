// Background worker, every 30 seconds:
//  - release stages whose review window passed without approval or an issue
//  - send any queued WhatsApp notifications (e.g. ones that failed earlier)
// Run with: npm run worker
import { prisma } from "../src/lib/db";
import { autoReleaseDue } from "../src/lib/deals";
import { sendInstalmentReminders } from "../src/lib/instalments";
import { processDueMediations } from "../src/lib/mediator";
import { dispatchNotifications } from "../src/lib/whatsapp/notify";

async function tick() {
  try {
    const n = await autoReleaseDue();
    if (n) console.log(`[auto-release] ${new Date().toISOString()} released ${n} stage(s)`);
    const m = await processDueMediations();
    if (m) console.log(`[mediator] ran ${m} mediation(s)`);
    const r = await sendInstalmentReminders();
    if (r) console.log(`[instalments] queued ${r} reminder(s)`);
    // Retry failed notifications up to 5 times within a day.
    await prisma.notification.updateMany({
      where: { status: "FAILED", attempts: { lt: 5 }, createdAt: { gt: new Date(Date.now() - 86400_000) } },
      data: { status: "PENDING" },
    });
    const sent = await dispatchNotifications();
    if (sent) console.log(`[notify] sent ${sent} message(s)`);
  } catch (e) {
    console.error("[worker] failed", e);
  }
}

console.log("[worker] running every 30 seconds");
tick();
setInterval(tick, 30_000);
