import type { MethodOption } from "../types";
import { planResponseSchema } from "../schemas";
import { chatJson } from "./client";
import { PLAN_SYSTEM, PLAN_MATHLIB_SYSTEM } from "./prompts";

export async function planSteps(
  problemText: string,
  method: MethodOption,
  useMathlib: boolean = true,
) {
  const system = useMathlib ? PLAN_MATHLIB_SYSTEM : PLAN_SYSTEM;
  return chatJson({
    system,
    user: JSON.stringify({ problemText, method }, null, 2),
    schema: planResponseSchema,
    schemaName: "planResponse",
  });
}
