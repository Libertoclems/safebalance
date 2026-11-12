"use client";

import { useActionState, useState, type ReactNode } from "react";
import type { FormState } from "@/app/actions";

type Props = {
  action: (state: FormState, fd: FormData) => Promise<FormState>;
  children?: ReactNode;
  submitLabel: string;
  submitClass?: string;
  className?: string;
  /**
   * Ask "are you sure?" before submitting. Shown inside the page, not as a
   * browser pop-up: in-app browsers (WhatsApp, Instagram, embedded views)
   * often block window.confirm and silently answer "no".
   */
  confirm?: string;
};

/** A form that runs a server action and shows its result underneath. */
export function ActionForm({ action, children, submitLabel, submitClass = "btn-primary", className = "", confirm }: Props) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [asking, setAsking] = useState(false);

  return (
    <form action={formAction} className={className} onSubmit={() => setAsking(false)}>
      {children}
      {confirm && !asking ? (
        <button type="button" className={submitClass} disabled={pending} onClick={() => setAsking(true)}>
          {pending ? "Working…" : submitLabel}
        </button>
      ) : confirm ? (
        <div className="mt-2 space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3" role="alertdialog" aria-label="Please confirm">
          <p className="text-sm font-medium text-stone-800">{confirm}</p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={submitClass} disabled={pending}>
              {pending ? "Working…" : "Yes, continue"}
            </button>
            <button type="button" className="btn-secondary" disabled={pending} onClick={() => setAsking(false)}>
              Go back
            </button>
          </div>
        </div>
      ) : (
        <button type="submit" className={submitClass} disabled={pending}>
          {pending ? "Working…" : submitLabel}
        </button>
      )}
      <Message state={state} />
    </form>
  );
}

export function Message({ state }: { state: FormState }) {
  if (state?.error) return <p className="mt-2 text-sm text-red-700" role="alert">{state.error}</p>;
  if (state?.ok && state.ok !== "Done") return <p className="mt-2 text-sm text-brand" role="status">{state.ok}</p>;
  return null;
}
