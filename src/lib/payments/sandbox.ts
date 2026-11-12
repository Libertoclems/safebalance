import crypto from "node:crypto";
import type { IncomingTransfer, PaymentProvider } from "./types";

// Sandbox provider for the pilot build. No real money moves.
// Account numbers start with 99 so they can never be mistaken for real ones.

export const SANDBOX_BANK = "SafeBalance Sandbox Bank";

function secret() {
  return process.env.SANDBOX_WEBHOOK_SECRET ?? "sandbox-secret-change-me";
}

export function signSandbox(rawBody: string) {
  return crypto.createHmac("sha256", secret()).update(rawBody).digest("hex");
}

export const sandboxProvider: PaymentProvider = {
  name: "sandbox",

  async createVirtualAccount({ reference }) {
    const digits = BigInt("0x" + crypto.createHash("sha256").update(reference).digest("hex").slice(0, 12)) % BigInt(100_000_000);
    return {
      accountNumber: "99" + digits.toString().padStart(8, "0"),
      bankName: SANDBOX_BANK,
      reference,
    };
  },

  async resolveAccount({ accountNumber }) {
    if (!/^\d{10}$/.test(accountNumber)) throw new Error("Account number must be 10 digits");
    // A real provider returns the name the bank has on file.
    return { accountName: "" };
  },

  async sendPayout({ reference, accountNumber }) {
    // Sandbox rule: account numbers ending in 000 fail, so failures can be tested.
    if (accountNumber.endsWith("000")) return { status: "FAILED", providerRef: `sbx_${reference}` };
    return { status: "SUCCESS", providerRef: `sbx_${reference}` };
  },

  verifyWebhook(rawBody, headers) {
    const given = headers.get("x-sandbox-signature") ?? "";
    const expected = signSandbox(rawBody);
    return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  },

  parseWebhook(rawBody): IncomingTransfer | null {
    const body = JSON.parse(rawBody);
    if (body.event !== "transfer.received") return null;
    return {
      eventId: String(body.id),
      reference: String(body.data.reference),
      amountKobo: Number(body.data.amount),
      senderName: body.data.sender_name,
    };
  },
};
