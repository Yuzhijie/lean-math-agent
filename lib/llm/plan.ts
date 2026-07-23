import type { MethodOption } from "../types";
import { planResponseSchema } from "../schemas";
import { chatJson } from "./client";
import { PLAN_SYSTEM } from "./prompts";

export async function planSteps(problemText: string, method: MethodOption) {
  return chatJson({
    system: PLAN_SYSTEM,
    user: JSON.stringify({ problemText, method }, null, 2),
    schema: planResponseSchema,
    schemaName: "planResponse",
  });
}
