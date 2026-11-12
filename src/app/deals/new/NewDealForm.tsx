"use client";

import { useActionState, useState } from "react";
import { createDealAction } from "@/app/actions";
import { Message } from "@/components/ActionForm";
import { formatNaira, nairaToKobo, stageFee } from "@/lib/money";

type Row = { key: number; title: string; amount: string; kind: "WORK" | "MATERIALS"; supplier: boolean };

function kobo(text: string) {
  try {
    return nairaToKobo(text);
  } catch {
    return 0;
  }
}

export function NewDealForm() {
  const [state, action, pending] = useActionState(createDealAction, undefined);
  const [rows, setRows] = useState<Row[]>([
    { key: 1, title: "Materials", amount: "", kind: "MATERIALS", supplier: false },
    { key: 2, title: "Work completed", amount: "", kind: "WORK", supplier: false },
  ]);
  const update = (key: number, patch: Partial<Row>) => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  const amounts = rows.map((r) => kobo(r.amount));
  const total = amounts.reduce((a, b) => a + b, 0);
  const fees = amounts.reduce((a, b) => a + (b ? stageFee(b) : 0), 0);

  return (
    <form action={action} className="space-y-4">
      <div className="card space-y-3">
        <div>
          <label className="label" htmlFor="title">What&apos;s the job?</label>
          <input id="title" name="title" className="input" placeholder="Install kitchen cabinets" required />
        </div>
        <div>
          <label className="label" htmlFor="description">Details the client should agree to</label>
          <textarea id="description" name="description" className="input min-h-24"
            placeholder="Size, materials, colour, what's included and what's not, how long it takes…" />
        </div>
        <div>
          <label className="label" htmlFor="reviewHours">Client review window</label>
          <select id="reviewHours" name="reviewHours" className="input" defaultValue="72">
            <option value="24">24 hours</option>
            <option value="48">48 hours</option>
            <option value="72">72 hours (recommended)</option>
            <option value="168">7 days</option>
          </select>
          <p className="mt-1 text-xs text-stone-500">If the client doesn&apos;t approve or raise an issue in time, you&apos;re paid automatically.</p>
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="font-semibold">Stages</h2>
        {rows.map((r, i) => (
          <div key={r.key} className="card space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-stone-500">Stage {i + 1}</p>
              {rows.length > 1 && (
                <button type="button" className="text-sm text-red-700" onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>
                  Remove
                </button>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
              <input name="stageTitle" className="input" placeholder="e.g. Fitting and finishing" value={r.title}
                onChange={(e) => update(r.key, { title: e.target.value })} required />
              <input name="stageAmount" className="input" inputMode="decimal" placeholder="₦ amount" value={r.amount}
                onChange={(e) => update(r.key, { amount: e.target.value })} required />
            </div>
            <input type="hidden" name="stageKind" value={r.kind} />
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={r.kind === "MATERIALS"}
                onChange={(e) => update(r.key, { kind: e.target.checked ? "MATERIALS" : "WORK", supplier: false })} />
              <span>Materials money: release as soon as the client pays, so I can buy materials</span>
            </label>
            {r.kind === "MATERIALS" && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={r.supplier} onChange={(e) => update(r.key, { supplier: e.target.checked })} />
                <span>Pay the supplier directly (clients trust this more)</span>
              </label>
            )}
            <div className={r.kind === "MATERIALS" && r.supplier ? "grid gap-2 sm:grid-cols-3" : "hidden"}>
              <input name="supplierName" className="input" placeholder="Supplier name" />
              <input name="supplierBank" className="input" placeholder="Bank" />
              <input name="supplierAcct" className="input" inputMode="numeric" placeholder="10-digit account" />
            </div>
          </div>
        ))}
        {rows.length < 10 && (
          <button type="button" className="btn-secondary"
            onClick={() => setRows([...rows, { key: Date.now(), title: "", amount: "", kind: "WORK", supplier: false }])}>
            + Add stage
          </button>
        )}
      </div>

      <div className="card space-y-1 text-sm">
        <div className="flex justify-between"><span>You receive</span><strong>{formatNaira(total)}</strong></div>
        <div className="flex justify-between text-stone-600"><span>SafeBalance fee (paid by client)</span><span>{formatNaira(fees)}</span></div>
        <div className="flex justify-between border-t border-stone-200 pt-1"><span>Client pays in total</span><strong>{formatNaira(total + fees)}</strong></div>
      </div>

      <button className="btn-primary w-full" disabled={pending}>{pending ? "Creating…" : "Create deal and get link"}</button>
      <Message state={state} />
    </form>
  );
}
