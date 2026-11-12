import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { botNumber, whatsappMode, type Button } from "@/lib/whatsapp/transport";
import { simSendPhoto, simSendText, simTapButton } from "./actions";
import { AutoRefresh } from "@/components/AutoRefresh";

// Test-mode WhatsApp simulator: two phones side by side.
// /dev/whatsapp?a=2348031112222&an=Emeka%20Obi&b=2348053334444&bn=Mrs%20Adeyemi

type Body = { text?: string; buttons?: Button[]; template?: string; kind?: string; buttonId?: string };

function linkify(text: string) {
  return text.split(/(https?:\/\/\S+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noreferrer" className="break-all text-sky-700 underline">{part}</a>
    ) : (
      <span key={i}>{part.split(/(\*[^*\n]+\*)/g).map((p, j) => (/^\*[^*]+\*$/.test(p) ? <strong key={j}>{p.slice(1, -1)}</strong> : p))}</span>
    ),
  );
}

async function Phone({ phone, name }: { phone: string; name: string }) {
  const messages = (await prisma.waMessage.findMany({ where: { phone }, orderBy: { createdAt: "desc" }, take: 60 })).reverse();
  const hidden = (
    <>
      <input type="hidden" name="phone" value={phone} />
      <input type="hidden" name="name" value={name} />
    </>
  );
  return (
    <div className="flex h-[640px] flex-col overflow-hidden rounded-3xl border-4 border-stone-800 bg-[#efe7dd]">
      <div className="bg-[#075e54] px-3 py-2 text-white">
        <p className="text-sm font-semibold">SafeBalance</p>
        <p className="text-xs opacity-80">{name} · +{phone}</p>
      </div>
      <div className="flex flex-1 flex-col-reverse overflow-y-auto p-2">
        <div className="space-y-2">
          {messages.length === 0 && <p className="py-8 text-center text-xs text-stone-500">Say “hi” to start.</p>}
          {messages.map((m) => {
            const b = JSON.parse(m.body) as Body;
            const mine = m.direction === "IN";
            const label = b.kind === "button" ? `🔘 ${b.buttonId?.split(":")[0]}` : b.kind === "image" || b.kind === "video" ? `📷 ${b.kind}${b.text ? ` · ${b.text}` : ""}` : b.text;
            return (
              <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-[13px] shadow-sm ${mine ? "bg-[#d9fdd3]" : "bg-white"}`}>
                  {b.template && <p className="mb-1 text-[11px] font-semibold text-amber-700">Template message (outside 24h window)</p>}
                  <p className="whitespace-pre-wrap">{mine ? label : linkify(b.text ?? "")}</p>
                  {!mine && b.buttons && (
                    <div className="mt-1.5 space-y-1 border-t border-stone-100 pt-1.5">
                      {b.buttons.map((btn) => (
                        <form key={btn.id} action={simTapButton}>
                          {hidden}
                          <input type="hidden" name="buttonId" value={btn.id} />
                          <input type="hidden" name="title" value={btn.title} />
                          <button className="w-full rounded py-1 text-center text-[13px] font-medium text-sky-700 hover:bg-sky-50">{btn.title}</button>
                        </form>
                      ))}
                    </div>
                  )}
                  <p className="mt-0.5 text-right text-[10px] text-stone-400">
                    {m.createdAt.toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos" })}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="space-y-1.5 bg-stone-100 p-2">
        <form action={simSendText} className="flex gap-1.5">
          {hidden}
          <input name="text" className="input !rounded-full !py-1.5 text-sm" placeholder="Type a message" autoComplete="off" />
          <button className="rounded-full bg-[#075e54] px-3 text-sm font-semibold text-white">Send</button>
        </form>
        <form action={simSendPhoto} className="flex items-center gap-1.5 text-xs">
          {hidden}
          <input type="file" name="file" accept="image/*,video/mp4" className="min-w-0 flex-1 text-xs" />
          <input name="caption" className="w-24 rounded border border-stone-300 px-1.5 py-1" placeholder="Caption" />
          <button className="rounded-full bg-stone-700 px-2.5 py-1 font-semibold text-white">📷 Send</button>
        </form>
      </div>
    </div>
  );
}

export default async function WhatsAppSimulator({
  searchParams,
}: {
  searchParams: Promise<{ a?: string; an?: string; b?: string; bn?: string }>;
}) {
  if (whatsappMode() !== "test") notFound();
  const q = await searchParams;
  const a = (q.a ?? "2348031112222").replace(/\D/g, "");
  const b = (q.b ?? "2348053334444").replace(/\D/g, "");
  return (
    <div className="space-y-4">
      <AutoRefresh />
      <div>
        <h1 className="text-2xl font-bold">WhatsApp simulator</h1>
        <p className="text-sm text-stone-600">
          Test mode: two phones talking to the bot (+{botNumber()}). Messages go through the same webhook parser and bot as real
          WhatsApp; nothing is sent to Meta. Change the numbers with ?a=…&amp;an=…&amp;b=…&amp;bn=… in the address.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Phone phone={a} name={q.an ?? "Emeka Obi"} />
        <Phone phone={b} name={q.bn ?? "Mrs Adeyemi"} />
      </div>
    </div>
  );
}

