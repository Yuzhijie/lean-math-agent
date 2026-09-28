import { bankRoute } from "@/lib/bank/http";
import { getProfile } from "@/lib/bank/profile";
import { BankError } from "@/lib/bank/store";
import { lt } from "@/lib/llm/output-locale";

type P = { id: string };
export const maxDuration = 300;

/** Template profile of a category (derived once and cached; ?refresh=1 recomputes). */
export const GET = bankRoute<P>(async ({ req, owner, params }) => {
  const u = new URL(req.url);
  const category = u.searchParams.get("category");
  if (!category) throw new BankError(lt("缺少 category 参数", "Missing category parameter"), 400);
  return { profile: await getProfile(owner, params.id, category, { refresh: u.searchParams.get("refresh") === "1" }) };
});
