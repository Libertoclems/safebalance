// Plain-language labels and colours for statuses shown in the app.

export const STAGE_LABEL: Record<string, { text: string; cls: string }> = {
  PENDING_APPROVAL: { text: "Extra work: waiting for client", cls: "bg-violet-100 text-violet-800" },
  UNFUNDED: { text: "Waiting for payment", cls: "bg-stone-100 text-stone-700" },
  PARTLY_FUNDED: { text: "Client paying in parts", cls: "bg-amber-100 text-amber-800" },
  FUNDED: { text: "Funds secured", cls: "bg-emerald-100 text-emerald-800" },
  IN_REVIEW: { text: "Client reviewing", cls: "bg-sky-100 text-sky-800" },
  DISPUTED: { text: "Issue raised", cls: "bg-red-100 text-red-800" },
  RELEASED: { text: "Paid", cls: "bg-brand text-white" },
  SPLIT: { text: "Settled by mediation", cls: "bg-amber-100 text-amber-800" },
  REFUNDED: { text: "Refunded to client", cls: "bg-stone-200 text-stone-700" },
  CANCELLED: { text: "Cancelled", cls: "bg-stone-100 text-stone-500" },
};

export const DEAL_LABEL: Record<string, { text: string; cls: string }> = {
  AWAITING_CLIENT: { text: "Waiting for client", cls: "bg-stone-100 text-stone-700" },
  ACTIVE: { text: "Active", cls: "bg-emerald-100 text-emerald-800" },
  COMPLETED: { text: "Completed", cls: "bg-brand text-white" },
  CANCELLED: { text: "Cancelled", cls: "bg-stone-100 text-stone-500" },
};

export function timeLeft(deadline: Date) {
  const ms = deadline.getTime() - Date.now();
  if (ms <= 0) return "any moment now";
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`;
}

export function when(d: Date) {
  return d.toLocaleString("en-NG", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Africa/Lagos" });
}
