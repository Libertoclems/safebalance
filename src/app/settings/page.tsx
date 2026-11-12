import { saveProfileAction, verifyIdAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ACCOUNTS, held } from "@/lib/ledger";
import { formatNaira } from "@/lib/money";
import { when } from "@/lib/labels";

const BANKS = [
  "Access Bank", "Ecobank", "Fidelity Bank", "First Bank", "FCMB", "GTBank", "Kuda", "Moniepoint", "OPay",
  "PalmPay", "Polaris Bank", "Stanbic IBTC", "Sterling Bank", "UBA", "Union Bank", "Wema Bank", "Zenith Bank",
];

export default async function SettingsPage() {
  const user = await requireUser("/settings");
  const owed = await held(prisma, ACCOUNTS.userPayable(user.id));
  const payouts = await prisma.payout.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 10 });

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Account</h1>

      {owed > 0 && (
        <div className="card border-amber-200 bg-amber-50 text-sm">
          <strong>{formatNaira(owed)}</strong> is waiting for you.{" "}
          {!user.idVerified || !user.bankAccountNumber ? "Verify your ID and add a bank account to receive it." : "It will be sent to your bank shortly."}
        </div>
      )}

      <div className="card space-y-3">
        <h2 className="font-semibold">Identity check</h2>
        {user.idVerified ? (
          <p className="text-sm text-brand">✓ Verified with your {user.idType}</p>
        ) : (
          <ActionForm action={verifyIdAction} submitLabel="Verify" className="space-y-2">
            <p className="text-sm text-stone-600">Needed before you can receive money. We only check that it matches your name.</p>
            <div className="grid gap-2 sm:grid-cols-[8rem_1fr]">
              <select name="idType" className="input" defaultValue="BVN">
                <option value="BVN">BVN</option>
                <option value="NIN">NIN</option>
              </select>
              <input name="idNumber" className="input font-mono" inputMode="numeric" maxLength={11} placeholder="11 digits" required />
            </div>
          </ActionForm>
        )}
      </div>

      <ActionForm action={saveProfileAction} submitLabel="Save" className="card space-y-3">
        <h2 className="font-semibold">Profile and payout account</h2>
        <div>
          <label className="label" htmlFor="name">Your name</label>
          <input id="name" name="name" className="input" defaultValue={user.name} required />
        </div>
        <p className="text-sm text-stone-600">Phone: {user.phone}</p>
        <div>
          <label className="label" htmlFor="bankName">Bank</label>
          <select id="bankName" name="bankName" className="input" defaultValue={user.bankName ?? ""}>
            <option value="">Choose your bank</option>
            {BANKS.map((b) => <option key={b}>{b}</option>)}
          </select>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="accountNumber">Account number</label>
            <input id="accountNumber" name="accountNumber" className="input font-mono" inputMode="numeric" maxLength={10}
              defaultValue={user.bankAccountNumber ?? ""} />
          </div>
          <div>
            <label className="label" htmlFor="accountName">Name on account</label>
            <input id="accountName" name="accountName" className="input" defaultValue={user.bankAccountName ?? ""} />
          </div>
        </div>
      </ActionForm>

      {payouts.length > 0 && (
        <div className="card">
          <h2 className="font-semibold">Recent payouts</h2>
          <ul className="mt-2 divide-y divide-stone-100 text-sm">
            {payouts.map((p) => (
              <li key={p.id} className="flex justify-between py-2">
                <span>{when(p.createdAt)} · {p.bankName} ••{p.accountNumber.slice(-4)}</span>
                <span className={p.status === "FAILED" ? "text-red-700" : ""}>
                  {formatNaira(p.amount)} {p.status === "SUCCESS" ? "sent" : p.status.toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
