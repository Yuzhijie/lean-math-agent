import { enumerateResponseSchema } from "../schemas";
import { chatJson } from "./client";
import { ENUMERATE_SYSTEM } from "./prompts";

export async function enumerateMethods(problemText: string) {
  return chatJson({
    system: ENUMERATE_SYSTEM,
    user: `Problem:\n${problemText}`,
    schema: enumerateResponseSchema,
    schemaName: "enumerateResponse",
  });
}
