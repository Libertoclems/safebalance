import { prisma } from "./db";
import { autoReleaseDue } from "./deals";
import { sendInstalmentReminders } from "./instalments";
import { processDueMediations } from "./mediator";
import { dispatchNotifications } from "./whatsapp/notify";

/**
 * Timed work: auto-release after the review window, start mediation when the
 * worker's response window ends, instalment reminders, and resending failed
 * WhatsApp messages. Run by scripts/auto-release.ts on a laptop/server, and by
 * the scheduled /api/cron route on Vercel.
 */
export async function runScheduledJobs() {
  const released = await autoReleaseDue();
  const mediations = await processDueMediations();
  const reminders = await sendInstalmentReminders();
  // Retry failed notifications up to 5 times within a day.
  await prisma.notification.updateMany({
    where: { status: "FAILED", attempts: { lt: 5 }, createdAt: { gt: new Date(Date.now() - 86400_000) } },
    data: { status: "PENDING" },
  });
  const sent = await dispatchNotifications();
  return { released, mediations, reminders, sent };
}
