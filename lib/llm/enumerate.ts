import type { MathDomain } from "../types";
import { enumerateResponseSchema } from "../schemas";
import { chatJson } from "./client";
import { ENUMERATE_SYSTEM } from "./prompts";
import { buildEnumeratePrompt } from "./agent-prompt";

export async function enumerateMethods(
  problemText: string,
  domain?: MathDomain,
) {
  const system = domain
    ? buildEnumeratePrompt(domain)
    : ENUMERATE_SYSTEM;
  return chatJson({
    system,
    user: `Problem:\n${problemText}`,
    schema: enumerateResponseSchema,
    schemaName: "enumerateResponse",
    role: "planner",
  });
}
