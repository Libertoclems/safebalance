import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";

const steps = [
  ["Send a deal link", "Describe the job and its stages, then share the link on WhatsApp. Your client needs no app."],
  ["Client locks the money", "They pay each stage by bank transfer before you start. You see “Funds secured”."],
  ["Show your work", "Upload photos or video when a stage is done. The client approves, or raises an issue."],
  ["Get paid, guaranteed", "Approved, or no reply in 72 hours? The money goes straight to your bank."],
];

export default async function Home() {
  if (await getCurrentUser()) redirect("/dashboard");
  return (
    <div className="space-y-10 py-4">
      <section className="space-y-4">
        <h1 className="text-3xl font-bold leading-tight sm:text-4xl">Never chase your balance again.</h1>
        <p className="max-w-xl text-lg text-stone-600">
          SafeBalance locks your client&apos;s money before work starts, so artisans and freelancers always get
          paid, and clients only pay for work that&apos;s done.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link href="/login" className="btn-primary">Start a protected deal</Link>
          <Link href="/login" className="btn-secondary">I received a deal link</Link>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        {steps.map(([title, body], i) => (
          <div key={title} className="card">
            <p className="text-sm font-semibold text-brand">Step {i + 1}</p>
            <h2 className="mt-1 font-semibold">{title}</h2>
            <p className="mt-1 text-sm text-stone-600">{body}</p>
          </div>
        ))}
      </section>

      <section className="card bg-brand-soft">
        <h2 className="font-semibold">Safe for clients too</h2>
        <p className="mt-1 text-sm text-stone-700">
          If the job isn&apos;t done, your locked money comes back. Every worker has a public record of completed
          jobs and ratings, and disputes are settled by a neutral mediator.
        </p>
      </section>
    </div>
  );
}
