import type { MathDomain, MethodOption, MethodScore } from "../types";
import { evaluateResponseSchema } from "../schemas";
import { chatJson } from "./client";
import { CRITIC_SYSTEM } from "./agent-prompt";

/**
 * Evaluate and score multiple solution methods on 5 dimensions.
 */
export async function evaluateMethods(args: {
  methods: MethodOption[];
  problemText: string;
  formalStatement?: string;
  domain?: MathDomain;
}): Promise<{
  scores: MethodScore[];
  recommended_method_id: string;
  comparison: string;
}> {
  const userMessage = [
    `Problem: ${args.problemText}`,
    args.formalStatement ? `Formal statement: ${args.formalStatement}` : null,
    args.domain ? `Domain: ${args.domain}` : null,
    `Methods to evaluate:`,
    JSON.stringify(args.methods, null, 2),
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await chatJson({
    system: CRITIC_SYSTEM,
    user: userMessage,
    schema: evaluateResponseSchema,
    schemaName: "evaluateResponse",
  });

  return {
    scores: result.scores,
    recommended_method_id: result.recommended_method_id,
    comparison: result.comparison,
  };
}
