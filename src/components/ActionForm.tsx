"use client";

import { useActionState, type ReactNode } from "react";
import type { FormState } from "@/app/actions";

type Props = {
  action: (state: FormState, fd: FormData) => Promise<FormState>;
  children?: ReactNode;
  submitLabel: string;
  submitClass?: string;
  className?: string;
  /** Ask "are you sure?" before submitting. */
  confirm?: string;
};

/** A form that runs a server action and shows its result underneath. */
export function ActionForm({ action, children, submitLabel, submitClass = "btn-primary", className = "", confirm }: Props) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      <button type="submit" className={submitClass} disabled={pending}>
        {pending ? "Working…" : submitLabel}
      </button>
      <Message state={state} />
    </form>
  );
}

export function Message({ state }: { state: FormState }) {
  if (state?.error) return <p className="mt-2 text-sm text-red-700" role="alert">{state.error}</p>;
  if (state?.ok && state.ok !== "Done") return <p className="mt-2 text-sm text-brand" role="status">{state.ok}</p>;
  return null;
}
