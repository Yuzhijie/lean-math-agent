import { notFound } from "next/navigation";
import { thawed } from "@/lib/scope";

// read THAW when the page is asked for, not when the app is built
export const dynamic = "force-dynamic";

/** The knowledge graph is frozen (lib/scope.ts, docs/SCOPE.md): this page exists only when THAW names "knowledge". */
export default function KnowledgeLayout({ children }: { children: React.ReactNode }) {
  if (!thawed("knowledge")) notFound();
  return children;
}
