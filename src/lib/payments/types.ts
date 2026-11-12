// Every payment partner (Paystack, Flutterwave, Monnify, a bank) plugs in
// behind this interface, so the rest of the app never talks to one directly.

export type VirtualAccount = {
  accountNumber: string;
  bankName: string;
  /** Our reference; incoming transfers to this account carry it back. */
  reference: string;
};

export type IncomingTransfer = {
  eventId: string; // provider's unique event id, used to ignore repeats
  reference: string; // matches VirtualAccount.reference
  amountKobo: number;
  senderName?: string;
};

export type PayoutRequest = {
  reference: string;
  amountKobo: number;
  bankName: string;
  accountNumber: string;
  accountName: string;
};

export type PayoutResult = { status: "SUCCESS" | "PENDING" | "FAILED"; providerRef: string };

export interface PaymentProvider {
  readonly name: string;
  /** One account number per stage, so each transfer is matched automatically. */
  createVirtualAccount(input: { reference: string; amountKobo: number; customerName: string }): Promise<VirtualAccount>;
  /** Confirm the account holder's name before saving payout details. */
  resolveAccount(input: { bankName: string; accountNumber: string }): Promise<{ accountName: string }>;
  sendPayout(input: PayoutRequest): Promise<PayoutResult>;
  /** Check the webhook really came from the provider. */
  verifyWebhook(rawBody: string, headers: Headers): boolean;
  /** Turn a provider webhook into an incoming transfer, or null if it is another kind of event. */
  parseWebhook(rawBody: string): IncomingTransfer | null;
}
