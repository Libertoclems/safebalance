import { notFound } from "next/navigation";
import { trustProfile } from "@/lib/deals";
import { when } from "@/lib/labels";

export default async function ProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await trustProfile(id);
  if (!p) notFound();
  const since = p.user.createdAt.toLocaleDateString("en-NG", { month: "long", year: "numeric" });

  return (
    <div className="space-y-5">
      <div className="card">
        <h1 className="text-2xl font-bold">{p.user.name || "SafeBalance user"}</h1>
        <p className="text-sm text-stone-600">
          {p.user.idVerified ? <span className="text-brand">✓ ID verified</span> : "ID not verified"} · Member since {since}
        </p>
        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <div><p className="text-2xl font-bold">{p.asWorker}</p><p className="text-xs text-stone-500">jobs completed</p></div>
          <div><p className="text-2xl font-bold">{p.avgStars ? p.avgStars.toFixed(1) : "–"}</p><p className="text-xs text-stone-500">average rating ({p.ratingCount})</p></div>
          <div><p className="text-2xl font-bold">{p.asClient}</p><p className="text-xs text-stone-500">jobs paid as client</p></div>
        </div>
        <p className="mt-3 text-xs text-stone-500">
          Issues raised on their work: {p.disputesAgainst} · Issues they raised as a client: {p.disputesRaised}
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="font-semibold">Recent reviews</h2>
        {p.ratings.length === 0 && <p className="text-sm text-stone-600">No reviews yet.</p>}
        {p.ratings.map((r) => (
          <div key={r.id} className="card !p-4 text-sm">
            <p className="text-amber-600">{"★".repeat(r.stars)}<span className="text-stone-300">{"★".repeat(5 - r.stars)}</span></p>
            {r.comment && <p className="mt-1">{r.comment}</p>}
            <p className="mt-1 text-xs text-stone-500">{when(r.createdAt)}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
