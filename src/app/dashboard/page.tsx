import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { lockedNow } from "@/lib/instalments";
import { DEAL_LABEL } from "@/lib/labels";
import { ACCOUNTS, held } from "@/lib/ledger";
import { formatNaira } from "@/lib/money";

export default async function Dashboard() {
  const user = await requireUser("/dashboard");
  const deals = await prisma.deal.findMany({
    where: { OR: [{ workerId: user.id }, { clientId: user.id }] },
    include: { stages: true, worker: true, client: true },
    orderBy: { createdAt: "desc" },
  });
  const owed = await held(prisma, ACCOUNTS.userPayable(user.id));
  const lockedByDeal = new Map(await Promise.all(deals.map(async (d) => [d.id, await lockedNow(d.stages)] as const)));
  const needsSetup = !user.name || !user.idVerified || !user.bankAccountNumber;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Hi{user.name ? `, ${user.name.split(" ")[0]}` : ""}</h1>
          <p className="text-sm text-stone-600">
            <Link href={`/u/${user.id}`} className="underline">View your public trust profile</Link>
          </p>
        </div>
        <Link href="/deals/new" className="btn-primary">+ New deal</Link>
      </div>

      {needsSetup && (
        <div className="card border-amber-200 bg-amber-50">
          <p className="font-semibold">Finish setting up so you can get paid</p>
          <p className="mt-1 text-sm text-stone-700">
            Add your name, verify your BVN or NIN, and add a bank account. Money owed to you is sent there automatically.
          </p>
          {owed > 0 && <p className="mt-2 text-sm font-semibold">{formatNaira(owed)} is waiting for you.</p>}
          <Link href="/settings" className="btn-secondary mt-3">Finish setup</Link>
        </div>
      )}

      <section className="space-y-3">
        <h2 className="font-semibold">Your deals</h2>
        {deals.length === 0 && (
          <div className="card text-sm text-stone-600">
            No deals yet. Create one and share the link with your client, or open a link someone sent you.
          </div>
        )}
        {deals.map((d) => {
          const role = d.workerId === user.id ? "worker" : "client";
          const other = role === "worker" ? d.client?.name || "Waiting for client" : d.worker.name || "Worker";
          const active = d.stages.filter((s) => s.status !== "CANCELLED");
          const total = active.reduce((n, s) => n + s.amount, 0);
          const secured = lockedByDeal.get(d.id) ?? 0;
          const paid = d.stages.filter((s) => s.status === "RELEASED").reduce((n, s) => n + s.amount, 0);
          const needsYou = role === "client"
            ? d.status === "AWAITING_CLIENT" || d.stages.some((s) => ["IN_REVIEW", "PENDING_APPROVAL"].includes(s.status))
            : d.stages.some((s) => s.status === "FUNDED");
          const label = DEAL_LABEL[d.status];
          return (
            <Link key={d.id} href={`/d/${d.code}`} className="card block transition hover:border-brand">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">{d.title}</p>
                  <p className="text-sm text-stone-600">
                    You&apos;re the {role} · {other}
                  </p>
                </div>
                <span className={`badge ${label.cls}`}>{label.text}</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
                <span>Total {formatNaira(total)}</span>
                {secured > 0 && <span className="text-emerald-700">Secured {formatNaira(secured)}</span>}
                {paid > 0 && <span className="text-stone-600">Paid {formatNaira(paid)}</span>}
                {needsYou && d.status !== "COMPLETED" && <span className="font-semibold text-sky-700">Needs your action</span>}
              </div>
            </Link>
          );
        })}
      </section>
    </div>
  );
}
