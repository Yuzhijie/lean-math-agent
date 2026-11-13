import { notFound } from "next/navigation";
import { thawed } from "@/lib/scope";

// read THAW when the page is asked for, not when the app is built
export const dynamic = "force-dynamic";

/** Payments are frozen (lib/scope.ts, docs/SCOPE.md): this page exists only when THAW names "payments". */
export default function SubscriptionLayout({ children }: { children: React.ReactNode }) {
  if (!thawed("payments")) notFound();
  return children;
}
