import type { MathDomain, MethodOption, ProofTechnique } from "../types";
import { methodOptionSchema } from "../schemas";
import { chatJson } from "../llm/client";
import { buildStrategistPrompt } from "../llm/agent-prompt";
import { z } from "zod";

interface StrategistConfig {
  id: string;
  techniqueFamilies: ProofTechnique[];
  domain: MathDomain;
  maxMethods: number;
}

const strategistResponseSchema = z.object({
  methods: z.array(methodOptionSchema).min(1),
});

/**
 * Run a single strategist agent that specializes in a family of techniques.
 */
export async function runStrategist(
  config: StrategistConfig,
  problemText: string,
  formalStatement?: string,
): Promise<MethodOption[]> {
  const systemPrompt = buildStrategistPrompt(config.domain, config.techniqueFamilies);

  const userMessage = [
    `Problem: ${problemText}`,
    formalStatement ? `Formal statement: ${formalStatement}` : null,
    `Generate up to ${config.maxMethods} distinct solution approaches using techniques from: ${config.techniqueFamilies.join(", ")}.`,
    `Each approach must include technique_tags from the assigned families.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await chatJson({
    system: systemPrompt,
    user: userMessage,
    schema: strategistResponseSchema,
    schemaName: "strategistResponse",
    role: "planner",
  });

  // Ensure each method has the assigned technique tags
  return result.methods.map((m) => ({
    ...m,
    id: `${config.id}-${m.id}`, // prefix with strategist id for deduplication
    technique_tags: m.technique_tags ?? config.techniqueFamilies.slice(0, 2),
  }));
}

/**
 * Default strategist assignments by domain.
 * Returns 2-4 strategists, each covering different technique families.
 */
export function getStrategistConfigs(
  domain: MathDomain,
): StrategistConfig[] {
  const configs: Record<string, StrategistConfig[]> = {
    competition_elementary: [
      { id: "strat-A", techniqueFamilies: ["direct_computation", "algebraic_manipulation"], domain, maxMethods: 3 },
      { id: "strat-B", techniqueFamilies: ["case_analysis", "extremal_principle", "construction"], domain, maxMethods: 3 },
      { id: "strat-C", techniqueFamilies: ["invariant", "pigeonhole", "double_counting"], domain, maxMethods: 2 },
    ],
    competition_inequality: [
      { id: "strat-A", techniqueFamilies: ["algebraic_manipulation", "inequality_chain"], domain, maxMethods: 3 },
      { id: "strat-B", techniqueFamilies: ["induction", "case_analysis"], domain, maxMethods: 3 },
      { id: "strat-C", techniqueFamilies: ["contradiction", "construction"], domain, maxMethods: 2 },
    ],
    number_theory: [
      { id: "strat-A", techniqueFamilies: ["direct_computation", "induction", "algebraic_manipulation"], domain, maxMethods: 3 },
      { id: "strat-B", techniqueFamilies: ["contradiction", "case_analysis", "contrapositive"], domain, maxMethods: 3 },
      { id: "strat-C", techniqueFamilies: ["construction", "invariant"], domain, maxMethods: 2 },
    ],
    competition_number_theory: [
      { id: "strat-A", techniqueFamilies: ["direct_computation", "algebraic_manipulation", "case_analysis"], domain, maxMethods: 3 },
      { id: "strat-B", techniqueFamilies: ["induction", "contradiction", "contrapositive"], domain, maxMethods: 3 },
      { id: "strat-C", techniqueFamilies: ["construction", "extremal_principle", "invariant"], domain, maxMethods: 2 },
    ],
    algebra: [
      { id: "strat-A", techniqueFamilies: ["algebraic_manipulation", "direct_computation"], domain, maxMethods: 3 },
      { id: "strat-B", techniqueFamilies: ["induction", "contradiction"], domain, maxMethods: 3 },
    ],
    real_analysis: [
      { id: "strat-A", techniqueFamilies: ["direct_computation", "inequality_chain"], domain, maxMethods: 3 },
      { id: "strat-B", techniqueFamilies: ["contradiction", "construction"], domain, maxMethods: 3 },
    ],
    combinatorics: [
      { id: "strat-A", techniqueFamilies: ["bijection", "double_counting", "generating_function"], domain, maxMethods: 3 },
      { id: "strat-B", techniqueFamilies: ["induction", "pigeonhole", "case_analysis"], domain, maxMethods: 3 },
      { id: "strat-C", techniqueFamilies: ["inclusion_exclusion", "construction", "direct_computation"], domain, maxMethods: 2 },
    ],
    competition_combinatorics: [
      { id: "strat-A", techniqueFamilies: ["bijection", "double_counting", "generating_function"], domain, maxMethods: 3 },
      { id: "strat-B", techniqueFamilies: ["pigeonhole", "extremal_principle", "construction"], domain, maxMethods: 3 },
      { id: "strat-C", techniqueFamilies: ["inclusion_exclusion", "invariant", "induction"], domain, maxMethods: 2 },
    ],
    set_theory: [
      { id: "strat-A", techniqueFamilies: ["subset_argument", "direct_computation", "algebraic_manipulation"], domain, maxMethods: 3 },
      { id: "strat-B", techniqueFamilies: ["cardinality_argument", "inclusion_exclusion", "bijection"], domain, maxMethods: 3 },
      { id: "strat-C", techniqueFamilies: ["contradiction", "construction", "induction"], domain, maxMethods: 2 },
    ],
    competition_set_theory: [
      { id: "strat-A", techniqueFamilies: ["inclusion_exclusion", "cardinality_argument", "direct_computation"], domain, maxMethods: 3 },
      { id: "strat-B", techniqueFamilies: ["subset_argument", "construction", "bijection"], domain, maxMethods: 3 },
      { id: "strat-C", techniqueFamilies: ["extremal_principle", "contradiction", "invariant"], domain, maxMethods: 2 },
    ],
  };

  // Default config for domains not explicitly listed
  return configs[domain] ?? [
    { id: "strat-A", techniqueFamilies: ["direct_computation", "algebraic_manipulation", "induction"], domain, maxMethods: 4 },
    { id: "strat-B", techniqueFamilies: ["contradiction", "case_analysis", "construction"], domain, maxMethods: 3 },
  ];
}
