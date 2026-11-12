"use client";

import { useActionState, useEffect, useState } from "react";
import { submitProofAction } from "@/app/actions";
import { Message } from "@/components/ActionForm";

/** Upload a photo or video as proof. Location is attached if the phone allows it. */
export function ProofForm({ stageId, more }: { stageId: string; more?: boolean }) {
  const [state, action, pending] = useActionState(submitProofAction, undefined);
  const [loc, setLoc] = useState<{ lat: number; lng: number } | null>(null);
  const [locNote, setLocNote] = useState("Getting location…");

  useEffect(() => {
    if (!navigator.geolocation) return setLocNote("Location not available on this device");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLoc({ lat: p.coords.latitude, lng: p.coords.longitude });
        setLocNote("Location will be attached");
      },
      () => setLocNote("Location not shared (optional)"),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }, []);

  return (
    <form action={action} className="space-y-2 rounded-xl border border-dashed border-stone-300 p-3">
      <p className="text-sm font-semibold">{more ? "Add more proof" : "Done with this stage? Upload proof"}</p>
      <input type="hidden" name="stageId" value={stageId} />
      <input type="hidden" name="lat" value={loc?.lat ?? ""} />
      <input type="hidden" name="lng" value={loc?.lng ?? ""} />
      <input type="file" name="file" accept="image/*,video/mp4,video/quicktime" capture="environment" required
        className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-soft file:px-3 file:py-2 file:font-semibold file:text-brand" />
      <input name="note" className="input" placeholder="Short note, e.g. “All 12 cabinets fitted”" />
      <p className="text-xs text-stone-500">{locNote}. Time is recorded automatically.</p>
      <button className="btn-primary" disabled={pending}>{pending ? "Uploading…" : "Submit proof"}</button>
      <Message state={state} />
    </form>
  );
}
