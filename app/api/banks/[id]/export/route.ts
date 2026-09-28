import { bankRoute } from "@/lib/bank/http";
import { getBank, listCategories, listItems } from "@/lib/bank/store";

type P = { id: string };

/**
 * Export as JSON Lines: first line the bank and its categories, then one
 * question per line. The same file imports back (JSONL import).
 */
export const GET = bankRoute<P>(async ({ owner, params }) => {
  const bank = getBank(owner, params.id);
  const lines = [JSON.stringify({ kind: "bank", bank: { name: bank.name, description: bank.description, language: bank.language, vocab: bank.vocab }, categories: listCategories(owner, params.id) })];
  for (const it of listItems(owner, params.id)) lines.push(JSON.stringify(it));
  const safe = bank.name.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60) || "bank";
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(safe)}.jsonl"; filename*=UTF-8''${encodeURIComponent(safe)}.jsonl`,
    },
  });
});
