import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../db";
import { formatNaira } from "../money";
import { UPLOAD_DIR } from "../uploads";
import type { Evidence } from "./types";

const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 3_700_000; // keeps each base64 image under the API's 5 MB limit
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/**
 * Text written by the two parties is evidence, not instructions. Angle
 * brackets are swapped so it can't close or fake the tags around it.
 */
export function untrusted(text: string) {
  return text.replace(/</g, "‹").replace(/>/g, "›");
}

const lagos = (d: Date) =>
  d.toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Lagos" });

/** Gather everything the mediator should see about one dispute. */
export async function buildEvidence(disputeId: string): Promise<Evidence> {
  const dispute = await prisma.dispute.findUniqueOrThrow({
    where: { id: disputeId },
    include: {
      statements: { orderBy: { createdAt: "asc" } },
      stage: {
        include: {
          proofs: { orderBy: { createdAt: "asc" } },
          deal: { include: { stages: { orderBy: { position: "asc" } }, events: { orderBy: { createdAt: "asc" } } } },
        },
      },
    },
  });
  const stage = dispute.stage;
  const deal = stage.deal;

  const lines: string[] = [];
  lines.push("<agreement>");
  lines.push(`Job title: ${untrusted(deal.title)}`);
  lines.push(`Agreed terms (written by the worker, accepted by the client):\n${untrusted(deal.description || "(no written terms)")}`);
  lines.push(`Review window: ${deal.reviewHours} hours`);
  lines.push("Stages:");
  for (const s of deal.stages) {
    lines.push(`- Stage ${s.position}: ${untrusted(s.title)}, ${formatNaira(s.amount)}, ${s.kind === "MATERIALS" ? "materials" : "work"}${s.isChangeOrder ? ", extra work added later" : ""}, status ${s.status}`);
  }
  lines.push("</agreement>");

  lines.push("");
  lines.push("<disputed_stage>");
  lines.push(`Stage ${stage.position}: ${untrusted(stage.title)}`);
  lines.push(`Locked amount for the worker: ${formatNaira(stage.amount)}`);
  if (stage.fundedAt) lines.push(`Funded: ${lagos(stage.fundedAt)}`);
  if (stage.submittedAt) lines.push(`Proof first submitted: ${lagos(stage.submittedAt)}`);
  lines.push(`Issue raised: ${lagos(dispute.createdAt)}`);
  lines.push(`Proof files: ${stage.proofs.length}`);
  for (const [i, p] of stage.proofs.entries()) {
    lines.push(
      `- Proof ${i + 1}: ${p.mimeType.startsWith("video/") ? "video" : "photo"}, uploaded ${lagos(p.capturedAt)}` +
        `${p.lat ? ", with location" : ", no location"}${p.note ? `, note: "${untrusted(p.note)}"` : ""}`,
    );
  }
  lines.push("</disputed_stage>");

  lines.push("");
  lines.push("<statements>");
  if (!dispute.statements.some((s) => s.role === "WORKER")) {
    lines.push("(The worker did not give their side within the response window.)");
  }
  for (const s of dispute.statements) {
    lines.push(`<statement from="${s.role === "WORKER" ? "worker" : "client"}" time="${lagos(s.createdAt)}">`);
    lines.push(untrusted(s.text));
    lines.push("</statement>");
  }
  lines.push("</statements>");

  lines.push("");
  lines.push("<deal_history>");
  for (const e of deal.events) lines.push(`${lagos(e.createdAt)} – ${untrusted(e.message)}`);
  lines.push("</deal_history>");

  // Proof photos for the disputed stage, newest last, within the size limits.
  const images: Evidence["images"] = [];
  let skipped = 0;
  const candidates = stage.proofs.slice(-MAX_IMAGES * 2);
  for (const [i, p] of candidates.entries()) {
    const type = IMAGE_TYPES.find((t) => t === p.mimeType);
    if (!type || images.length >= MAX_IMAGES) {
      skipped++;
      continue;
    }
    try {
      const data = await fs.readFile(path.join(UPLOAD_DIR, path.basename(p.filePath)));
      if (data.length > MAX_IMAGE_BYTES) {
        skipped++;
        continue;
      }
      images.push({ mimeType: type, base64: data.toString("base64"), label: `Proof ${i + 1} (uploaded ${lagos(p.capturedAt)})` });
    } catch {
      skipped++;
    }
  }
  skipped += stage.proofs.length - candidates.length;
  if (skipped) lines.push(`\n(${skipped} proof file(s) could not be shown: videos, unsupported formats or very large files.)`);

  return { text: lines.join("\n"), images, imagesSkipped: skipped };
}
