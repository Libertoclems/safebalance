"use client";

import { useActionState } from "react";
import { quickLoginAction } from "../actions";
import { Message } from "@/components/ActionForm";

/** Test mode: sign in instantly with any phone number. */
export function QuickLoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(quickLoginAction, undefined);
  return (
    <form action={action} className="card space-y-3">
      <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
        Test version: sign in with any phone number, no code needed. Use a made-up number if you like, and don&apos;t
        enter real bank or ID details.
      </p>
      <input type="hidden" name="next" value={next} />
      <div>
        <label className="label" htmlFor="q-phone">Phone number</label>
        <input id="q-phone" name="phone" className="input" inputMode="tel" autoComplete="tel" placeholder="0803 123 4567" required />
        <p className="mt-1 text-xs text-stone-500">Use the same number next time to get back to your deals.</p>
      </div>
      <div>
        <label className="label" htmlFor="q-name">Your name</label>
        <input id="q-name" name="name" className="input" autoComplete="name" placeholder="Emeka Obi" />
      </div>
      <button className="btn-primary w-full" disabled={pending}>{pending ? "Signing in…" : "Enter"}</button>
      <Message state={state} />
    </form>
  );
}
