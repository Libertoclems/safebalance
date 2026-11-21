import { sandboxProvider } from "./sandbox";
import type { PaymentProvider } from "./types";

/** PAYMENT_PROVIDER as typed in .env or a hosting dashboard, with stray quotes/spaces removed. */
function providerName() {
  return (process.env.PAYMENT_PROVIDER ?? "sandbox").trim().replace(/^["']|["']$/g, "").toLowerCase() || "sandbox";
}

// Pick the active payment partner. Only the sandbox exists in the pilot build;
// a real adapter is added here once a licensed partner is signed (see README).
export function getProvider(): PaymentProvider {
  const name = providerName();
  switch (name) {
    case "sandbox":
      return sandboxProvider;
    default:
      throw new Error(`Payment provider "${name}" is not set up yet`);
  }
}

export function isTestMode() {
  return providerName() === "sandbox";
}
