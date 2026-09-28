import { bankRoute } from "@/lib/bank/http";
import { readAsset } from "@/lib/bank/store";

type P = { id: string; name: string };

const TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  pdf: "application/pdf", csv: "text/csv; charset=utf-8", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  json: "application/json", jsonl: "application/x-ndjson", md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8",
};

/** A bank file (original import, image). PDFs open at a page with #page=N. */
export const GET = bankRoute<P>(async ({ owner, params }) => {
  const data = readAsset(owner, params.id, params.name);
  const ext = params.name.split(".").pop()!.toLowerCase();
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": TYPES[ext] ?? "application/octet-stream",
      // SVG could carry script: never render it inline as a document.
      "Content-Disposition": ext === "svg" ? "attachment" : "inline",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
    },
  });
});
