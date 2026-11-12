// Generates the logo images from the SVG drawing. Run: node scripts/make-brand-images.mjs
import fs from "node:fs/promises";
import sharp from "sharp";

const GREEN = "#0f7a4a";
const lock = `<path d="M22 28V21a10 10 0 0 1 20 0v7" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/><rect x="14" y="27" width="36" height="26" rx="6" fill="#fff"/><path d="M23 40l6 6 12-12" fill="none" stroke="${GREEN}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>`;

// Rounded tile with transparent corners: website, documents, slides.
const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${GREEN}"/>${lock}</svg>`;

// Full square, padlock shrunk to the middle: survives circle crops (WhatsApp, social profiles)
// and the rounded corners phones add to home-screen icons.
const square = (scale) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${GREEN}"/><g transform="translate(32 33) scale(${scale}) translate(-32 -33)">${lock}</g></svg>`;

await fs.mkdir("public/brand", { recursive: true });
await fs.writeFile("public/brand/logo.svg", tile);
await sharp(Buffer.from(tile)).resize(512, 512).png().toFile("public/brand/logo-512.png");
await sharp(Buffer.from(square(0.62))).resize(640, 640).png().toFile("public/brand/whatsapp-profile.png");
await sharp(Buffer.from(square(0.8))).resize(180, 180).png().toFile("src/app/apple-icon.png");
console.log("Wrote public/brand/logo.svg, logo-512.png, whatsapp-profile.png and src/app/apple-icon.png");
