import { LoginForm } from "./LoginForm";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <div className="mx-auto max-w-sm space-y-4">
      <h1 className="text-2xl font-bold">Sign in</h1>
      <p className="text-sm text-stone-600">Use your phone number. We&apos;ll send you a 6-digit code.</p>
      <LoginForm next={next ?? "/dashboard"} />
    </div>
  );
}
