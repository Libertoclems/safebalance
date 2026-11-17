import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { readStoredFile } from "@/lib/storage";

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

  try {
    const data = await readStoredFile(proof.filePath);
    return new NextResponse(new Uint8Array(data), {
      headers: { "Content-Type": proof.mimeType, "Cache-Control": "private, max-age=3600" },
    });
  } catch {
    return NextResponse.json({ error: "file missing" }, { status: 404 });
  }
}
