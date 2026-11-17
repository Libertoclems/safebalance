// Background worker for running on a laptop or your own server (on Vercel the
// scheduled /api/cron route does this instead). Every 30 seconds it runs the
// timed jobs in src/lib/jobs.ts. Run with: npm run worker
import { runScheduledJobs } from "../src/lib/jobs";

async function tick() {
  try {
    const r = await runScheduledJobs();
    if (r.released || r.mediations || r.reminders || r.sent) console.log(`[worker] ${new Date().toISOString()}`, r);
  } catch (e) {
    console.error("[worker] failed", e);
  }
}

console.log("[worker] running every 30 seconds");
tick();
setInterval(tick, 30_000);
