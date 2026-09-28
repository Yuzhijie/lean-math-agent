import { bankRoute } from "@/lib/bank/http";
import { deleteCategory } from "@/lib/bank/store";

type P = { id: string; categoryId: string };

export const DELETE = bankRoute<P>(async ({ owner, params }) => {
  deleteCategory(owner, params.id, params.categoryId);
  return { ok: true };
});
