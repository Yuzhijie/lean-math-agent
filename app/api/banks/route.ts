import { z } from "zod";
import { bankRoute, jsonBody } from "@/lib/bank/http";
import { createBank, listBanks, listItems } from "@/lib/bank/store";

/** GET: the account's banks (with question counts). POST: create a bank. */
export const GET = bankRoute(async ({ owner }) => ({
  owner: owner === "local" ? "local" : "account",
  banks: listBanks(owner).map((b) => ({ ...b, item_count: listItems(owner, b.id).length })),
}));

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000).optional(),
  language: z.enum(["zh", "en", "mixed"]).optional(),
  allow_model: z.boolean().optional(),
  pin_language: z.boolean().optional(),
  vocab: z.array(z.string().max(80)).max(2000).optional(),
});

export const POST = bankRoute(async ({ req, owner }) => ({ bank: createBank(owner, createSchema.parse(await jsonBody(req))) }));
