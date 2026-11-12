import Link from "next/link";
import { notFound } from "next/navigation";
import {
  acceptDealAction, addChangeOrderAction, approveStageAction, cancelDealAction, fastForwardAction,
  raiseDisputeAction, rateAction, respondChangeOrderAction,
} from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { autoReleaseDue } from "@/lib/deals";
import { DEAL_LABEL, STAGE_LABEL, timeLeft, when } from "@/lib/labels";
import { formatNaira } from "@/lib/money";
import { isTestMode } from "@/lib/payments";
import { DisputePanel } from "./DisputePanel";
import { FundingBox } from "./FundingBox";
import { lockedNow } from "@/lib/instalments";
import { ProofForm } from "./ProofForm";
import { ShareBox } from "./ShareBox";

export default async function DealPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  await autoReleaseDue(); // backup for the background worker

  const user = await getCurrentUser();
  const deal = await prisma.deal.findUnique({
    where: { code },
    include: {
      worker: true,
      client: true,
      stages: {
        orderBy: { position: "asc" },
        include: {
          proofs: { orderBy: { createdAt: "asc" } },
          disputes: { include: { statements: { orderBy: { createdAt: "asc" } } } },
        },
      },
      events: { orderBy: { createdAt: "desc" } },
      ratings: true,
    },
  });
  if (!deal) notFound();

  const isWorker = user?.id === deal.workerId;
  const isClient = !!user && user.id === deal.clientId;
  const isAdmin = user?.role === "admin";
  const canSee = isWorker || isClient || isAdmin || deal.status === "AWAITING_CLIENT";
  if (!canSee) {
    return (
      <div className="card text-center">
        <p className="font-semibold">This deal is private</p>
        <p className="mt-1 text-sm text-stone-600">Only the worker and client on this deal can see it.</p>
        {!user && <Link href={`/login?next=/d/${code}`} className="btn-primary mt-3">Sign in</Link>}
      </div>
    );
  }

  const test = isTestMode();
  const live = deal.stages.filter((s) => s.status !== "CANCELLED");
  const total = live.reduce((n, s) => n + s.amount, 0);
  const totalFees = live.reduce((n, s) => n + s.fee, 0);
  const secured = await lockedNow(deal.stages);
  const nextToFund = deal.stages.find((s) => s.status === "UNFUNDED" || s.status === "PARTLY_FUNDED");
  const shareUrl = `${process.env.APP_URL ?? "http://localhost:3000"}/d/${deal.code}`;
  const closed = ["COMPLETED", "CANCELLED"].includes(deal.status);
  const myRating = deal.ratings.find((r) => r.fromId === user?.id);
  const workerDone = await prisma.deal.count({ where: { workerId: deal.workerId, status: "COMPLETED" } });
  const label = DEAL_LABEL[deal.status];

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{deal.title}</h1>
          <p className="text-sm text-stone-600">
            Worker: <Link className="underline" href={`/u/${deal.workerId}`}>{deal.worker.name || "Worker"}</Link>
            {deal.worker.idVerified && <span className="ml-1 text-brand">✓ ID verified</span>}
            <span className="text-stone-400"> · {workerDone} completed deal{workerDone === 1 ? "" : "s"}</span>
            {deal.client && <> · Client: <Link className="underline" href={`/u/${deal.clientId}`}>{deal.client.name || "Client"}</Link></>}
          </p>
        </div>
        <span className={`badge shrink-0 ${label.cls}`}>{label.text}</span>
      </div>

      {isWorker && deal.status === "AWAITING_CLIENT" && (
        <ShareBox url={shareUrl} title={deal.title} total={formatNaira(total + totalFees)} />
      )}

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="card !p-3"><p className="text-xs text-stone-500">Job total</p><p className="font-bold">{formatNaira(total)}</p></div>
        <div className="card !p-3"><p className="text-xs text-stone-500">Locked now</p><p className="font-bold text-emerald-700">{formatNaira(secured)}</p></div>
        <div className="card !p-3"><p className="text-xs text-stone-500">Review window</p><p className="font-bold">{deal.reviewHours}h</p></div>
      </div>

      {deal.description && (
        <div className="card">
          <p className="text-sm font-semibold text-stone-500">Agreed terms</p>
          <p className="mt-1 whitespace-pre-wrap text-sm">{deal.description}</p>
        </div>
      )}

      {deal.status === "AWAITING_CLIENT" && !isWorker && (
        <div className="card space-y-2 border-brand">
          <p className="font-semibold">Accept these terms to start</p>
          <p className="text-sm text-stone-600">
            You&apos;ll pay each stage into a locked account before the work on it starts. The worker is only paid when you
            approve, or if you don&apos;t respond within {deal.reviewHours} hours of them submitting proof. If there&apos;s a
            problem, raise an issue and the money stays locked until it&apos;s settled.
          </p>
          <p className="text-sm">You&apos;ll pay {formatNaira(total + totalFees)} in total, including {formatNaira(totalFees)} in fees.</p>
          {user ? (
            <ActionForm action={acceptDealAction} submitLabel="Accept terms">
              <input type="hidden" name="dealId" value={deal.id} />
              <input type="hidden" name="code" value={deal.code} />
            </ActionForm>
          ) : (
            <Link href={`/login?next=/d/${deal.code}`} className="btn-primary">Sign in to accept</Link>
          )}
        </div>
      )}

      <section className="space-y-3">
        <h2 className="font-semibold">Stages</h2>
        {deal.stages.map((s) => {
          const st = STAGE_LABEL[s.status];
          const openDispute = s.disputes.find((d) => d.status === "OPEN");
          return (
            <div key={s.id} className={`card space-y-3 ${s.status === "CANCELLED" ? "opacity-60" : ""}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">
                    {s.position}. {s.title}
                    {s.isChangeOrder && <span className="ml-2 text-xs font-normal text-violet-700">extra work</span>}
                  </p>
                  <p className="text-sm text-stone-600">
                    {formatNaira(s.amount)}
                    {(isClient || deal.status === "AWAITING_CLIENT") && <span className="text-stone-400"> + {formatNaira(s.fee)} fee</span>}
                    {s.kind === "MATERIALS" && <span> · materials{s.supplierName ? `, paid to ${s.supplierName}` : ", released on payment"}</span>}
                  </p>
                </div>
                <span className={`badge shrink-0 ${st.cls}`}>{st.text}</span>
              </div>

              {/* Paying for the next stage: all at once, or pay small small */}
              {deal.status === "ACTIVE" && nextToFund?.id === s.id && (isClient || isWorker) && (
                <FundingBox stage={s} isClient={isClient} isWorker={isWorker} test={test} />
              )}

              {/* Client: respond to extra work */}
              {isClient && s.status === "PENDING_APPROVAL" && (
                <div className="flex flex-wrap gap-2">
                  <ActionForm action={respondChangeOrderAction} submitLabel="Accept extra work">
                    <input type="hidden" name="stageId" value={s.id} /><input type="hidden" name="accept" value="yes" />
                  </ActionForm>
                  <ActionForm action={respondChangeOrderAction} submitLabel="Decline" submitClass="btn-secondary">
                    <input type="hidden" name="stageId" value={s.id} /><input type="hidden" name="accept" value="no" />
                  </ActionForm>
                </div>
              )}

              {s.status === "FUNDED" && isWorker && (
                <>
                  <p className="text-sm text-emerald-700">The client&apos;s money is locked. You can start this stage.</p>
                  <ProofForm stageId={s.id} />
                </>
              )}
              {s.status === "FUNDED" && isClient && (
                <p className="text-sm text-stone-600">Your money is locked. The worker will upload proof when this stage is done.</p>
              )}

              {/* Proof */}
              {s.proofs.length > 0 && (isWorker || isClient || isAdmin) && (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {s.proofs.map((p) => (
                    <a key={p.id} href={`/api/files/${p.id}`} target="_blank" className="block overflow-hidden rounded-lg border border-stone-200">
                      {p.mimeType.startsWith("image/") ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={`/api/files/${p.id}`} alt={p.note || "Proof of work"} className="aspect-square w-full object-cover" />
                      ) : (
                        <div className="grid aspect-square place-items-center bg-stone-100 text-sm">▶ Video</div>
                      )}
                      <p className="px-2 py-1 text-xs text-stone-600">
                        {when(p.capturedAt)}{p.lat ? " · 📍 location attached" : ""}{p.note ? ` · ${p.note}` : ""}
                      </p>
                    </a>
                  ))}
                </div>
              )}

              {s.status === "IN_REVIEW" && s.reviewDeadline && (
                <div className="space-y-2">
                  <p className="text-sm text-sky-800">
                    {isClient ? "Check the work. " : "Waiting for the client. "}
                    Auto-release in <strong>{timeLeft(s.reviewDeadline)}</strong> if there&apos;s no response.
                  </p>
                  {isClient && (
                    <>
                      <ActionForm action={approveStageAction} submitLabel={`Approve and release ${formatNaira(s.amount)}`}
                        confirm="Release the money to the worker? This can't be undone.">
                        <input type="hidden" name="stageId" value={s.id} />
                      </ActionForm>
                      <details className="rounded-xl border border-stone-200 p-3">
                        <summary className="cursor-pointer text-sm font-semibold text-red-700">Something is wrong? Raise an issue</summary>
                        <ActionForm action={raiseDisputeAction} submitLabel="Raise issue and keep money locked" submitClass="btn-danger mt-2" className="mt-2">
                          <input type="hidden" name="stageId" value={s.id} />
                          <textarea name="reason" className="input min-h-20" required
                            placeholder="What's wrong? Be specific, e.g. “3 cabinet doors don't close and the colour is not what we agreed.”" />
                        </ActionForm>
                      </details>
                    </>
                  )}
                  {isWorker && <ProofForm stageId={s.id} more />}
                  {test && (isWorker || isClient) && (
                    <ActionForm action={fastForwardAction} submitLabel="Skip the review timer (test)" submitClass="btn-secondary">
                      <input type="hidden" name="stageId" value={s.id} />
                    </ActionForm>
                  )}
                </div>
              )}

              {isClient && s.status === "FUNDED" && (
                <details className="rounded-xl border border-stone-200 p-3">
                  <summary className="cursor-pointer text-sm text-stone-600">Worker not showing up? Raise an issue</summary>
                  <ActionForm action={raiseDisputeAction} submitLabel="Raise issue" submitClass="btn-danger mt-2" className="mt-2">
                    <input type="hidden" name="stageId" value={s.id} />
                    <textarea name="reason" className="input min-h-20" required placeholder="Describe what happened" />
                  </ActionForm>
                </details>
              )}

              {openDispute && (isWorker || isClient || isAdmin) && (
                <DisputePanel dispute={openDispute} stage={s} isWorker={isWorker} isClient={isClient} test={test} />
              )}
              {s.disputes.filter((d) => d.status === "RESOLVED").map((d) => (
                <p key={d.id} className="rounded-lg bg-stone-50 p-2 text-sm text-stone-700">
                  Issue settled{d.resolvedById === "mediation" ? " by agreement" : " by a mediator"}:{" "}
                  {formatNaira(d.workerShare ?? 0)} to the worker, {formatNaira(s.amount - (d.workerShare ?? 0))} of the stage back to the client.{" "}
                  {d.resolutionNote}
                </p>
              ))}
            </div>
          );
        })}
      </section>

      {isWorker && deal.status === "ACTIVE" && (
        <details className="card">
          <summary className="cursor-pointer font-semibold">Client asked for extra work?</summary>
          <p className="mt-2 text-sm text-stone-600">Add it here. The client must accept and pay for it before you start it.</p>
          <ActionForm action={addChangeOrderAction} submitLabel="Send to client" className="mt-3 space-y-2">
            <input type="hidden" name="dealId" value={deal.id} />
            <input name="title" className="input" placeholder="e.g. Paint the gate" required />
            <input name="amount" className="input" inputMode="decimal" placeholder="₦ amount" required />
          </ActionForm>
        </details>
      )}

      {closed && (isWorker || isClient) && deal.clientId && (
        <div className="card">
          {myRating ? (
            <p className="text-sm">You rated this deal {"★".repeat(myRating.stars)}. Thank you.</p>
          ) : (
            <ActionForm action={rateAction} submitLabel="Submit rating" className="space-y-2">
              <p className="font-semibold">Rate the {isWorker ? "client" : "worker"}</p>
              <input type="hidden" name="dealId" value={deal.id} />
              <select name="stars" className="input" defaultValue="5">
                <option value="5">★★★★★ Excellent</option>
                <option value="4">★★★★ Good</option>
                <option value="3">★★★ Okay</option>
                <option value="2">★★ Poor</option>
                <option value="1">★ Bad</option>
              </select>
              <input name="comment" className="input" placeholder={isWorker ? "e.g. Paid on time, clear instructions" : "e.g. Neat work, finished early"} />
            </ActionForm>
          )}
        </div>
      )}

      {(isWorker || isClient) && !closed && (
        <details className="card">
          <summary className="cursor-pointer text-sm text-stone-600">Cancel this deal</summary>
          <p className="mt-2 text-sm text-stone-600">
            {isWorker
              ? "Any money locked for unfinished stages goes back to the client. Paid stages stay paid."
              : "You can cancel while no money is locked. If work is in progress, raise an issue on that stage instead."}
          </p>
          <ActionForm action={cancelDealAction} submitLabel="Cancel deal" submitClass="btn-danger" className="mt-2 space-y-2"
            confirm="Cancel this deal? This can't be undone.">
            <input type="hidden" name="dealId" value={deal.id} />
            <input name="reason" className="input" placeholder="Reason (optional)" />
          </ActionForm>
        </details>
      )}

      {(isWorker || isClient || isAdmin) && (
        <section className="space-y-2">
          <h2 className="font-semibold">History</h2>
          <ol className="space-y-2 border-l-2 border-stone-200 pl-4">
            {deal.events.map((e) => (
              <li key={e.id} className="text-sm">
                <p className="text-xs text-stone-500">{when(e.createdAt)}</p>
                <p>{e.message}</p>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
