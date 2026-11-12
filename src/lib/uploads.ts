import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DealError } from "./deals";

// Proof-of-work files live outside the public folder and are only served to
// the people on the deal (see /api/files/[id]). Production: object storage.

export const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
};

export async function saveUpload(file: File) {
  if (!file || file.size === 0) throw new DealError("Choose a photo or video");
  return saveBuffer(Buffer.from(await file.arrayBuffer()), file.type);
}

export async function saveBuffer(data: Buffer, mimeType: string) {
  const type = mimeType.split(";")[0].trim();
  if (data.length === 0) throw new DealError("The file is empty");
  if (data.length > MAX_BYTES) throw new DealError("Files must be under 15 MB");
  const ext = ALLOWED[type];
  if (!ext) throw new DealError("Send a photo (JPG, PNG, WEBP, HEIC) or video (MP4, MOV)");
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const name = crypto.randomBytes(16).toString("hex") + ext;
  await fs.writeFile(path.join(UPLOAD_DIR, name), data);
  return { filePath: name, mimeType: type };
}
