import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveDisputeAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { when } from "@/lib/labels";
import { checkLedger } from "@/lib/ledger";
import { readSuggestion } from "@/lib/mediator";
import { formatNaira } from "@/lib/money";

export default async function AdminPage() {
  const user = await requireUser("/admin");
  if (user.role !== "admin") notFound();

  const [ledger, disputes, unmatched, failed, counts] = await Promise.all([
    checkLedger(prisma),
    prisma.dispute.findMany({
      where: { status: "OPEN" },
      include: {
        stage: { include: { deal: { include: { worker: true, client: true } }, proofs: true } },
        statements: { orderBy: { createdAt: "asc" } },
      },
      orderBy: [{ escalated: "desc" }, { createdAt: "asc" }],
    }),
    prisma.ledgerTransaction.findMany({ where: { kind: "UNMATCHED_TRANSFER" }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.payout.findMany({ where: { status: "FAILED" }, orderBy: { createdAt: "desc" }, take: 20 }),
    Promise.all([
      prisma.deal.count(),
      prisma.deal.count({ where: { status: "COMPLETED" } }),
      prisma.user.count(),
    ]),
  ]);
  const [dealCount, completed, userCount] = counts;

  const stat = (label: string, value: string, warn = false) => (
    <div className={`card !p-3 ${warn ? "border-red-300 bg-red-50" : ""}`}>
      <p className="text-xs text-stone-500">{label}</p>
      <p className="font-bold">{value}</p>
    </div>
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Admin</h1>

      <section className="space-y-2">
        <h2 className="font-semibold">Books</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {stat("Ledger check", ledger.ok ? "Balanced ✓" : `${ledger.unbalanced.length} unbalanced`, !ledger.ok)}
          {stat("Held at partner", formatNaira(ledger.clearing))}
          {stat("Locked in escrow", formatNaira(ledger.lockedInEscrow))}
          {stat("Owed to users (awaiting payout)", formatNaira(ledger.owedToUsers))}
          {stat("Fees earned", formatNaira(ledger.fees))}
          {stat("Unmatched transfers", formatNaira(ledger.suspense), ledger.suspense > 0)}
        </div>
        <p className="text-xs text-stone-500">
          Held at partner should equal locked + owed + fees + unmatched. Check it against the partner&apos;s statement daily.
          {" "}{dealCount} deals · {completed} completed · {userCount} users
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Open disputes ({disputes.length})</h2>
        {disputes.length === 0 && <p className="text-sm text-stone-600">None.</p>}
        {disputes.map((d) => {
          const s = d.stage;
          const ai = readSuggestion(d.aiSuggestion);
          const state = d.escalated
            ? { text: "Needs a person", cls: "bg-red-100 text-red-800" }
            : d.aiStatus === "READY"
              ? { text: "Waiting for both sides to answer", cls: "bg-sky-100 text-sky-800" }
              : d.aiStatus === "WAITING_RESPONSE"
                ? { text: "Waiting for worker's side", cls: "bg-stone-100 text-stone-700" }
                : { text: `Mediator: ${d.aiStatus.toLowerCase()}`, cls: "bg-violet-100 text-violet-800" };
          return (
            <div key={d.id} className={`card space-y-2 text-sm ${d.escalated ? "border-red-300" : ""}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link href={`/d/${s.deal.code}`} className="font-semibold underline">{s.deal.title}: {s.title}</Link>
                <span className={`badge ${state.cls}`}>{state.text}</span>
              </div>
              <p className="text-stone-500">Raised {when(d.createdAt)}{d.escalationReason ? ` · ${d.escalationReason}` : ""}</p>
              <p>Worker: {s.deal.worker.name} ({s.deal.worker.phone}) · Client: {s.deal.client?.name} ({s.deal.client?.phone})</p>
              <p>Locked: <strong>{formatNaira(s.amount)}</strong> + {formatNaira(s.fee)} fee · {s.proofs.length} proof file(s)</p>
              {d.statements.map((st) => (
                <p key={st.id} className={`rounded-lg p-2 ${st.role === "CLIENT" ? "bg-red-50 text-red-900" : "bg-emerald-50 text-emerald-900"}`}>
                  <strong>{st.role === "CLIENT" ? "Client" : "Worker"}:</strong> “{st.text}”
                </p>
              ))}
              {ai && (
                <details className="rounded-lg border border-violet-200 bg-violet-50/50 p-2" open={d.escalated}>
                  <summary className="cursor-pointer font-semibold">
                    {d.aiSource === "demo" ? "Demo suggestion" : `AI suggestion (${d.aiSource})`}: {formatNaira(ai.workerShareKobo)} to worker ·
                    confidence {ai.confidence}
                  </summary>
                  <p className="mt-2">{ai.summary}</p>
                  <ul className="mt-1 list-disc pl-5">
                    {ai.findings.map((f, i) => <li key={i}>{f.point} <span className="text-stone-500">({f.evidence}; favours {f.favours})</span></li>)}
                  </ul>
                  <p className="mt-1">{ai.reasoning}</p>
                  {ai.needsHuman && <p className="mt-1 text-red-800">Flagged for a person: {ai.needsHumanReason}</p>}
                  <p className="mt-1 text-xs text-stone-500">
                    Saw {ai.imagesShown} photo(s){ai.imagesSkipped ? `, ${ai.imagesSkipped} file(s) not shown` : ""} ·
                    worker {d.workerDecision ?? "no answer"} · client {d.clientDecision ?? "no answer"}
                  </p>
                </details>
              )}
              {d.aiError && <p className="text-xs text-stone-500">Mediator note: {d.aiError}</p>}
              <ActionForm action={resolveDisputeAction} submitLabel="Settle dispute" className="space-y-2"
                confirm="Pay out this settlement? This can't be undone.">
                <input type="hidden" name="disputeId" value={d.id} />
                <label className="label">Amount to the worker (₦0 to {formatNaira(s.amount)}); the rest is refunded</label>
                <input name="workerShare" className="input" inputMode="decimal" placeholder="e.g. 60,000" required
                  defaultValue={ai ? String(ai.workerShareKobo / 100) : undefined} />
                <input name="note" className="input" placeholder="Reason for the decision, shown to both sides" required />
              </ActionForm>
            </div>
          );
        })}
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Unmatched transfers</h2>
        {unmatched.length === 0 && <p className="text-sm text-stone-600">None.</p>}
        <ul className="space-y-1 text-sm">
          {unmatched.map((t) => <li key={t.id}>{when(t.createdAt)} · {t.memo}</li>)}
        </ul>
        {unmatched.length > 0 && (
          <p className="text-xs text-stone-500">Refund or apply these with the partner; tooling for this comes in V2.</p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Failed payouts</h2>
        {failed.length === 0 && <p className="text-sm text-stone-600">None.</p>}
        <ul className="space-y-1 text-sm">
          {failed.map((p) => (
            <li key={p.id}>{when(p.createdAt)} · {p.recipientName} · {p.bankName} {p.accountNumber} · {formatNaira(p.amount)}</li>
          ))}
        </ul>
        {failed.length > 0 && (
          <p className="text-xs text-stone-500">The money is back in the person&apos;s balance. It retries when they update their bank details.</p>
        )}
      </section>
    </div>
  );
}
