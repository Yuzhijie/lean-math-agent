export const TAXONOMY = [
  "rewrite",
  "calc",
  "induction",
  "cases",
  "ring_or_linarith",
  "constructive",
  "contradiction",
  "other",
] as const;

export type TaxonomyCategory = (typeof TAXONOMY)[number];

export type BuildStatus = "idle" | "ok" | "fail" | "unavailable";

export type StepStatus = "pending" | "ok" | "fail";

export interface MethodOption {
  id: string;
  category: TaxonomyCategory;
  title: string;
  inspiration: string;
  pros: string;
  cons: string;
  lean_sketch: string;
  confidence: number;
}

export interface ProofStep {
  index: number;
  plain_goal: string;
  lean_goal: string;
  plain_explanation: string;
  lean_code: string;
  status: StepStatus;
  build_log?: string;
}

export interface Session {
  id: string;
  problem_text: string;
  methods: MethodOption[];
  selected_method_id?: string;
  theorem_name?: string;
  theorem_type?: string;
  steps: ProofStep[];
  assembled_lean: string;
  build_status: BuildStatus;
  comparison_summary?: string;
  out_of_domain_warning?: string;
  created_at: number;
}
