import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { UPLOAD_DIR } from "@/lib/uploads";

// Serve a proof file only to the worker, the client or an admin.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "sign in" }, { status: 401 });

  const proof = await prisma.proof.findUnique({ where: { id }, include: { stage: { include: { deal: true } } } });
  if (!proof) return NextResponse.json({ error: "not found" }, { status: 404 });
  const deal = proof.stage.deal;
  if (user.role !== "admin" && user.id !== deal.workerId && user.id !== deal.clientId) {
    return NextResponse.json({ error: "not allowed" }, { status: 403 });
  }

  const file = path.join(UPLOAD_DIR, path.basename(proof.filePath));
  try {
    const data = await fs.readFile(file);
    return new NextResponse(data, {
      headers: { "Content-Type": proof.mimeType, "Cache-Control": "private, max-age=3600" },
    });
  } catch {
    return NextResponse.json({ error: "file missing" }, { status: 404 });
  }
}
