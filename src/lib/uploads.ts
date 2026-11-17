import { DealError } from "./deals";
import { storeFile } from "./storage";

// Proof-of-work files: checked here, then stored privately (see storage.ts)
// and only served to the people on the deal (see /api/files/[id]).

export { UPLOAD_DIR } from "./storage";

// Vercel rejects request bodies over 4.5 MB, so uploads there are capped at 4 MB.
const MAX_MB = process.env.VERCEL ? 4 : 15;
const MAX_BYTES = MAX_MB * 1024 * 1024;
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
  if (data.length > MAX_BYTES) throw new DealError(`Files must be under ${MAX_MB} MB`);
  const ext = ALLOWED[type];
  if (!ext) throw new DealError("Send a photo (JPG, PNG, WEBP, HEIC) or video (MP4, MOV)");
  return { filePath: await storeFile(data, type, ext), mimeType: type };
}
