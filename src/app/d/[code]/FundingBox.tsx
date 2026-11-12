import type { Stage } from "@prisma/client";
import { cancelPlanAction, prepareFundingAction, setPlanAction, simulateTransferAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { EVERY, savingProgress, schedule } from "@/lib/instalments";
import { formatNaira } from "@/lib/money";

const day = (d: Date) => d.toLocaleDateString("en-NG", { weekday: "short", day: "numeric", month: "short", timeZone: "Africa/Lagos" });

function Progress({ saved, target, percent }: { saved: number; target: number; percent: number }) {
  return (
    <div>
      <div className="h-2.5 overflow-hidden rounded-full bg-stone-200">
        <div className="h-full rounded-full bg-amber-500" style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-1 text-xs text-stone-600">
        {formatNaira(saved)} of {formatNaira(target)} saved ({percent}%)
      </p>
    </div>
  );
}

/** Paying for a stage: all at once or "pay small small". */
export async function FundingBox({ stage, isClient, isWorker, test }: { stage: Stage; isClient: boolean; isWorker: boolean; test: boolean }) {
  const p = await savingProgress(stage.id);

  if (isWorker) {
    if (stage.status !== "PARTLY_FUNDED") return null;
    return (
      <div className="space-y-2 rounded-xl bg-amber-50 p-3 text-sm">
        <p className="font-semibold">The client is paying for this stage in parts</p>
        <Progress {...p} />
        <p className="text-stone-700">Don&apos;t start yet. You&apos;ll be told when it&apos;s fully paid and shows Funds secured.</p>
      </div>
    );
  }
  if (!isClient) return null;

  if (!stage.accountNumber) {
    return (
      <div className="space-y-2">
        <ActionForm action={prepareFundingAction} submitLabel={`Pay ${formatNaira(p.target)} to lock this stage`}>
          <input type="hidden" name="stageId" value={stage.id} />
        </ActionForm>
        <p className="text-xs text-stone-500">Don&apos;t have it all now? You can pay in parts (pay small small) once you have the account details.</p>
      </div>
    );
  }

  const rows = p.plan ? schedule(p.plan, p.remaining) : [];
  return (
    <div className="space-y-3 rounded-xl bg-stone-50 p-3 text-sm">
      {p.saved > 0 && <Progress {...p} />}
      <div className="space-y-1">
        <p className="font-semibold">
          Transfer {p.saved > 0 ? "the remaining" : "exactly"} {formatNaira(p.remaining)}
          {p.plan ? ", or your next part," : ""} to:
        </p>
        <p>Bank: <strong>{stage.accountBank}</strong></p>
        <p>Account number: <strong className="font-mono text-base">{stage.accountNumber}</strong></p>
        <p className="text-stone-600">This account is only for this stage. Every transfer to it is locked for this job. Work starts once it&apos;s fully paid.</p>
      </div>

      {p.plan ? (
        <div className="space-y-2 rounded-lg border border-amber-200 bg-white p-2.5">
          <p className="font-semibold">Your plan: {p.plan.parts} parts, {EVERY[p.plan.every as keyof typeof EVERY]}</p>
          <ul className="space-y-0.5">
            {rows.slice(0, 4).map((r, i) => (
              <li key={i} className="flex justify-between">
                <span>{i === 0 && r.due <= new Date() ? "Due now" : day(r.due)}</span>
                <span>{formatNaira(r.amount)}</span>
              </li>
            ))}
            {rows.length > 4 && <li className="text-stone-500">…and {rows.length - 4} more</li>}
          </ul>
          <p className="text-xs text-stone-500">We remind you on WhatsApp the day before each payment. Paying early or more is fine.</p>
          <ActionForm action={cancelPlanAction} submitLabel="Stop the plan" submitClass="btn-secondary !py-1.5">
            <input type="hidden" name="stageId" value={stage.id} />
          </ActionForm>
        </div>
      ) : (
        p.remaining >= 2 * 100_00 && (
          <details className="rounded-lg border border-stone-200 bg-white p-2.5">
            <summary className="cursor-pointer font-semibold">Don&apos;t have it all now? Pay small small</summary>
            <ActionForm action={setPlanAction} submitLabel="Set my plan" className="mt-2 space-y-2">
              <input type="hidden" name="stageId" value={stage.id} />
              <div className="grid grid-cols-2 gap-2">
                <select name="parts" className="input" defaultValue="4">
                  {[2, 3, 4, 6, 8, 12].map((n) => (
                    <option key={n} value={n}>{n} × {formatNaira(Math.ceil(p.remaining / n / 100) * 100)}</option>
                  ))}
                </select>
                <select name="every" className="input" defaultValue="WEEK">
                  {Object.entries(EVERY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <p className="text-xs text-stone-500">
                Your money is locked for this job as you pay. It doesn&apos;t earn interest. If the deal is cancelled before work
                starts, everything you saved comes back to you.
              </p>
            </ActionForm>
          </details>
        )
      )}

      {test && (
        <div className="flex flex-wrap gap-2">
          {p.plan && p.nextAmount < p.remaining && (
            <ActionForm action={simulateTransferAction} submitLabel={`Simulate part payment ${formatNaira(p.nextAmount)} (test)`} submitClass="btn-secondary">
              <input type="hidden" name="stageId" value={stage.id} />
              <input type="hidden" name="amount" value={p.nextAmount} />
            </ActionForm>
          )}
          <ActionForm action={simulateTransferAction} submitLabel={`Simulate full transfer ${formatNaira(p.remaining)} (test)`} submitClass="btn-secondary">
            <input type="hidden" name="stageId" value={stage.id} />
          </ActionForm>
        </div>
      )}
    </div>
  );
}
