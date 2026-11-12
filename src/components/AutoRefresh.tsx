"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-fetch the chats every few seconds so notifications from the other side appear. */
export function AutoRefresh({ ms = 2500 }: { ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), ms);
    return () => clearInterval(t);
  }, [router, ms]);
  return null;
}
