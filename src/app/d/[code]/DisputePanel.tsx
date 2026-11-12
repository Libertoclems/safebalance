import type { Dispute, DisputeStatement, Stage } from "@prisma/client";
import { addStatementAction, decideSuggestionAction, skipResponseWindowAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { AutoRefresh } from "@/components/AutoRefresh";
import { timeLeft, when } from "@/lib/labels";
import { readSuggestion } from "@/lib/mediator";
import { formatNaira, proRataFee } from "@/lib/money";

type Props = {
  dispute: Dispute & { statements: DisputeStatement[] };
  stage: Stage;
  isWorker: boolean;
  isClient: boolean;
  test: boolean;
};

const FAVOURS: Record<string, string> = {
  worker: "bg-emerald-100 text-emerald-800",
  client: "bg-sky-100 text-sky-800",
  neither: "bg-stone-100 text-stone-700",
};

export function DisputePanel({ dispute: d, stage, isWorker, isClient, test }: Props) {
  const s = readSuggestion(d.aiSuggestion);
  const working = !d.escalated && ["PENDING", "RUNNING", "FAILED"].includes(d.aiStatus);
  const myDecision = isWorker ? d.workerDecision : isClient ? d.clientDecision : null;
  const workerAnswered = d.statements.some((x) => x.role === "WORKER");

  return (
    <div className="space-y-3 rounded-xl border border-red-200 bg-red-50/60 p-3 text-sm">
      {working && <AutoRefresh ms={3000} />}
      <p className="font-semibold text-red-900">Issue under review · the money stays locked</p>

      <div className="space-y-2">
        {d.statements.map((st) => (
          <div key={st.id} className="rounded-lg bg-white p-2.5">
            <p className="text-xs font-semibold text-stone-500">
              {st.role === "WORKER" ? "Worker's side" : "Client's complaint"} · {when(st.createdAt)}
            </p>
            <p className="mt-0.5 whitespace-pre-wrap">{st.text}</p>
          </div>
        ))}
      </div>

      {d.aiStatus === "WAITING_RESPONSE" && !d.escalated && (
        <div className="space-y-2">
          {isWorker && !workerAnswered ? (
            <ActionForm action={addStatementAction} submitLabel="Send my side" className="space-y-2">
              <p className="font-semibold">Give your side{d.responseDeadline ? ` (${timeLeft(d.responseDeadline)} left)` : ""}</p>
              <p className="text-stone-600">
                Explain what was agreed and what you did. The mediator also sees your proof photos and the deal history.
              </p>
              <input type="hidden" name="disputeId" value={d.id} />
              <textarea name="text" className="input min-h-24" required
                placeholder="e.g. The doors close fine; the client asked for a different colour after fitting, which wasn't in the agreement." />
            </ActionForm>
          ) : (
            <p className="text-stone-700">
              Waiting for the worker&apos;s side{d.responseDeadline ? ` (up to ${timeLeft(d.responseDeadline)})` : ""}. Then the
              mediator suggests a fair outcome.
            </p>
          )}
          {test && (isWorker || isClient) && (
            <ActionForm action={skipResponseWindowAction} submitLabel="Skip the 48-hour wait (test)" submitClass="btn-secondary">
              <input type="hidden" name="disputeId" value={d.id} />
            </ActionForm>
          )}
        </div>
      )}

      {working && <p className="text-stone-700">⏳ The mediator is looking at the evidence. This usually takes under a minute.</p>}

      {s && d.aiStatus === "READY" && !d.escalated && (
        <div className="space-y-3 rounded-xl border border-stone-200 bg-white p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="font-semibold">Mediator&apos;s suggestion</p>
            {d.aiSource === "demo" ? (
              <span className="badge bg-amber-100 text-amber-800">Demo, not a real assessment</span>
            ) : (
              <span className="badge bg-violet-100 text-violet-800">AI suggestion</span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 text-center">
            <div className="rounded-lg bg-emerald-50 p-2">
              <p className="text-xs text-stone-500">To the worker</p>
              <p className="text-lg font-bold">{formatNaira(s.workerShareKobo)}</p>
              <p className="text-xs text-stone-500">{s.workerSharePercent}% of {formatNaira(stage.amount)}</p>
            </div>
            <div className="rounded-lg bg-sky-50 p-2">
              <p className="text-xs text-stone-500">Back to the client</p>
              <p className="text-lg font-bold">
                {formatNaira(stage.amount - s.workerShareKobo + stage.fee - proRataFee(stage.fee, s.workerShareKobo, stage.amount))}
              </p>
              <p className="text-xs text-stone-500">includes the unused part of the fee</p>
            </div>
          </div>
          <p>{s.summary}</p>
          <ul className="space-y-1">
            {s.findings.map((f, i) => (
              <li key={i} className="flex gap-2">
                <span className={`badge h-fit shrink-0 ${FAVOURS[f.favours]}`}>{f.favours === "neither" ? "neutral" : f.favours}</span>
                <span>{f.point} <span className="text-stone-500">({f.evidence})</span></span>
              </li>
            ))}
          </ul>
          <p className="rounded-lg bg-stone-50 p-2">{s.reasoning}</p>
          {s.nextSteps.length > 0 && (
            <div>
              <p className="font-semibold">Suggested next steps</p>
              <ul className="list-disc pl-5">{s.nextSteps.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </div>
          )}
          <p className="text-xs text-stone-500">
            Nothing is paid unless you both accept. If either of you rejects it, a human mediator decides.
            Worker: {d.workerDecision ? (d.workerDecision === "ACCEPT" ? "accepted" : "rejected") : "not answered yet"} ·
            Client: {d.clientDecision ? (d.clientDecision === "ACCEPT" ? "accepted" : "rejected") : "not answered yet"}
          </p>
          {(isWorker || isClient) && !myDecision && (
            <div className="flex flex-wrap gap-2">
              <ActionForm action={decideSuggestionAction} submitLabel="Accept suggestion"
                confirm="Accept this split? If the other side also accepts, the money is paid out straight away.">
                <input type="hidden" name="disputeId" value={d.id} />
                <input type="hidden" name="accept" value="yes" />
              </ActionForm>
              <ActionForm action={decideSuggestionAction} submitLabel="Reject, ask a person" submitClass="btn-secondary">
                <input type="hidden" name="disputeId" value={d.id} />
                <input type="hidden" name="accept" value="no" />
              </ActionForm>
            </div>
          )}
        </div>
      )}

      {d.escalated && (
        <div className="rounded-lg bg-white p-2.5">
          <p className="font-semibold">A human mediator will decide</p>
          <p className="text-stone-700">
            {d.escalationReason} They will contact you both within 5 working days. The money stays locked until then.
          </p>
        </div>
      )}
    </div>
  );
}
