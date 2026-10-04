import { bankRoute } from "@/lib/bank/http";
import { templateOptions } from "@/lib/bank/select";
import { getBank, listCategories, listItems } from "@/lib/bank/store";

type P = { id: string };

/**
 * Pickers for the problem generator's "local bank as template" mode: the
 * bank's levels, topics (categories with question counts) and knowledge
 * points, plus a compact index so the browser can count matching questions.
 */
export const GET = bankRoute<P>(async ({ owner, params }) => {
  const bank = getBank(owner, params.id);
  return { bank: { id: bank.id, name: bank.name, allow_model: bank.allow_model }, ...templateOptions(listItems(owner, params.id), listCategories(owner, params.id)) };
});
