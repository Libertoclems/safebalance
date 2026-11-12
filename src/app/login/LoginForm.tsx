"use client";

import { useActionState, useState } from "react";
import { sendCodeAction, verifyCodeAction } from "../actions";
import { Message } from "@/components/ActionForm";

export function LoginForm({ next }: { next: string }) {
  const [phone, setPhone] = useState("");
  const [sent, sendAction, sending] = useActionState(sendCodeAction, undefined);
  const [verified, verifyAction, verifying] = useActionState(verifyCodeAction, undefined);
  const onCodeStep = sent?.step === "code" || verified?.step === "code";

  if (!onCodeStep) {
    return (
      <form action={sendAction} className="card space-y-3">
        <div>
          <label className="label" htmlFor="phone">Phone number</label>
          <input id="phone" name="phone" className="input" inputMode="tel" autoComplete="tel"
            placeholder="0803 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} required />
        </div>
        <button className="btn-primary w-full" disabled={sending}>{sending ? "Sending…" : "Send code"}</button>
        <Message state={sent} />
      </form>
    );
  }

  return (
    <form action={verifyAction} className="card space-y-3">
      <input type="hidden" name="phone" value={phone} />
      <input type="hidden" name="next" value={next} />
      <p className="text-sm text-stone-600">Code sent to <strong>{phone}</strong>.</p>
      {sent?.testCode && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Test mode: your code is <strong className="font-mono">{sent.testCode}</strong>
        </p>
      )}
      <div>
        <label className="label" htmlFor="code">6-digit code</label>
        <input id="code" name="code" className="input font-mono tracking-widest" inputMode="numeric"
          autoComplete="one-time-code" maxLength={6} required />
      </div>
      <div>
        <label className="label" htmlFor="name">Your name <span className="font-normal text-stone-500">(first time only)</span></label>
        <input id="name" name="name" className="input" autoComplete="name" placeholder="Emeka Obi" />
      </div>
      <button className="btn-primary w-full" disabled={verifying}>{verifying ? "Checking…" : "Sign in"}</button>
      <Message state={verified} />
    </form>
  );
}
