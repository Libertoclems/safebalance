import { NextResponse } from "next/server";
import { runScheduledJobs } from "@/lib/jobs";

// Called by Vercel Cron (see vercel.json). Vercel sends
// "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET is set in the project.
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "not allowed" }, { status: 401 });
  }
  const result = await runScheduledJobs();
  return NextResponse.json({ ok: true, ...result });
}
