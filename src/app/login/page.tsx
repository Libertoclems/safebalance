import { quickLoginEnabled } from "@/lib/auth";
import { LoginForm } from "./LoginForm";
import { QuickLoginForm } from "./QuickLoginForm";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const quick = quickLoginEnabled();
  return (
    <div className="mx-auto max-w-sm space-y-4">
      <h1 className="text-2xl font-bold">Sign in</h1>
      {quick ? (
        <>
          <QuickLoginForm next={next ?? "/dashboard"} />
          <details className="card">
            <summary className="cursor-pointer text-sm font-semibold">Sign in with a code (admins)</summary>
            <div className="mt-3">
              <LoginForm next={next ?? "/dashboard"} />
            </div>
          </details>
        </>
      ) : (
        <>
          <p className="text-sm text-stone-600">Use your phone number. We&apos;ll send you a 6-digit code.</p>
          <LoginForm next={next ?? "/dashboard"} />
        </>
      )}
    </div>
  );
}
