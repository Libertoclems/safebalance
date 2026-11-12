"use client";

import { useState } from "react";

export function ShareBox({ url, title, total }: { url: string; title: string; total: string }) {
  const [copied, setCopied] = useState(false);
  const text = `Hi! Here are the terms for "${title}" (${total}). Your money stays locked with SafeBalance until each stage is done: ${url}`;
  return (
    <div className="card border-brand bg-brand-soft">
      <p className="font-semibold">Send this link to your client</p>
      <p className="mt-1 break-all font-mono text-sm">{url}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <a className="btn-primary" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">
          Share on WhatsApp
        </a>
        <button type="button" className="btn-secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(url);
            setCopied(true);
          }}>
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
    </div>
  );
}
