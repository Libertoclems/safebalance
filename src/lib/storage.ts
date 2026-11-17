import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { get, put } from "@vercel/blob";

// Where proof-of-work files live.
//  - On Vercel: a PRIVATE Vercel Blob store. Files can't be opened by URL;
//    they're only served through /api/files/[id] to the people on the deal.
//  - On a laptop without Blob set up: the local uploads/ folder.
// Stored keys look like "blob:<pathname>" or a plain local file name.

export const UPLOAD_DIR = path.join(process.cwd(), "uploads");

function blobEnabled() {
  return !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}

export async function storeFile(data: Buffer, mimeType: string, ext: string) {
  const name = crypto.randomBytes(16).toString("hex") + ext;
  if (blobEnabled()) {
    const result = await put(`proofs/${name}`, data, { access: "private", contentType: mimeType, addRandomSuffix: false });
    return `blob:${result.pathname}`;
  }
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, name), data);
  return name;
}

export async function readStoredFile(key: string): Promise<Buffer> {
  if (key.startsWith("blob:")) {
    const result = await get(key.slice(5), { access: "private" });
    if (!result || result.statusCode !== 200) throw new Error("file not found");
    return Buffer.from(await new Response(result.stream).arrayBuffer());
  }
  return fs.readFile(path.join(UPLOAD_DIR, path.basename(key)));
}
