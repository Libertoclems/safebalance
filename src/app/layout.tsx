import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { logoutAction } from "./actions";
import { getCurrentUser } from "@/lib/auth";
import { isTestMode } from "@/lib/payments";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "SafeBalance — never chase your balance again",
  description: "Escrow for Nigerian artisans and freelancers: the client's money is locked before work starts.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0f7a4a" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {isTestMode() && (
          <div className="bg-amber-100 px-4 py-1.5 text-center text-xs font-medium text-amber-900">
            Test mode: no real money moves. Payments and ID checks are simulated.
          </div>
        )}
        <header className="border-b border-stone-200 bg-white">
          <nav className="mx-auto flex max-w-3xl items-center gap-4 px-4 py-3">
            <Link href={user ? "/dashboard" : "/"} className="flex items-center gap-2 font-bold text-brand">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand text-sm text-white">S</span>
              SafeBalance
            </Link>
            <div className="ml-auto flex items-center gap-3 text-sm">
              {user ? (
                <>
                  <Link href="/dashboard" className="hover:text-brand">Deals</Link>
                  <Link href="/settings" className="hover:text-brand">Account</Link>
                  {user.role === "admin" && <Link href="/admin" className="hover:text-brand">Admin</Link>}
                  <form action={logoutAction}>
                    <button className="text-stone-500 hover:text-stone-800">Sign out</button>
                  </form>
                </>
              ) : (
                <Link href="/login" className="btn-primary !py-1.5">Sign in</Link>
              )}
            </div>
          </nav>
        </header>
        <main className="mx-auto max-w-3xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
