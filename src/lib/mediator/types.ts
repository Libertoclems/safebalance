import * as z from "zod/v4";

// What the mediator must return. The API enforces this shape (structured
// outputs); the code then checks the numbers again before using them.

export const SuggestionSchema = z.object({
  summary: z.string().describe("Neutral summary of what happened, 2-4 sentences, plain English."),
  findings: z
    .array(
      z.object({
        point: z.string().describe("One finding, one sentence."),
        evidence: z.string().describe("What it is based on: the agreed terms, a statement, a proof photo, or the deal history."),
        favours: z.enum(["worker", "client", "neither"]),
      }),
    )
    .describe("The key findings, most important first. 2-6 items."),
  workerSharePercent: z
    .number()
    .describe("Whole number from 0 to 100: the share of the locked stage amount that should go to the worker. The rest is refunded to the client."),
  reasoning: z.string().describe("Why this split is fair, addressed to both people, under 120 words, no legal jargon."),
  nextSteps: z.array(z.string()).describe("Practical next steps, e.g. a fix the worker agrees to make. Can be empty."),
  confidence: z.enum(["low", "medium", "high"]).describe("How clearly the evidence supports the suggestion."),
  needsHuman: z.boolean().describe("True if a person must decide: evidence missing or contradictory, safety issues, fraud, threats, or anything outside workmanship and payment."),
  needsHumanReason: z.string().describe("If needsHuman is true, why. Otherwise an empty string."),
});

export type Suggestion = z.infer<typeof SuggestionSchema>;

/** Stored on the dispute, with the naira amounts worked out by our code (never by the model). */
export type StoredSuggestion = Suggestion & {
  workerShareKobo: number;
  refundKobo: number; // stage amount minus the worker's share (fees are handled at settlement)
  imagesShown: number;
  imagesSkipped: number;
};

/** The evidence package handed to the mediator. */
export type Evidence = {
  text: string;
  images: { mimeType: "image/jpeg" | "image/png" | "image/webp"; base64: string; label: string }[];
  imagesSkipped: number;
};

export type MediatorEngine = {
  name: string;
  suggest(evidence: Evidence): Promise<{ ok: true; suggestion: Suggestion; source: string } | { ok: false; reason: string; needsHuman: boolean }>;
};
