import type { RunMetrics } from "./llm/usage-tracker";
// ── Proof Method Taxonomy (8 categories) ──────────────────────────────
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

// ── Math Domains (19 domains) ─────────────────────────────────────────
export const MATH_DOMAINS = [
  "nat_arithmetic",
  "int_arithmetic",
  "rational",
  "real_analysis",
  "combinatorics",
  "number_theory",
  "set_theory",
  "algebra",
  "geometry",
  "linear_algebra",
  "topology",
  "abstract_algebra",
  "competition_elementary",
  "competition_inequality",
  "competition_number_theory",
  "competition_combinatorics",
  "competition_set_theory",
  "inequality",
  "logic",
  "computation",
  "other",
] as const;

export type MathDomain = (typeof MATH_DOMAINS)[number];

// ── Proof Techniques (17 orthogonal techniques) ──────────────────────
export const PROOF_TECHNIQUES = [
  "direct_computation",
  "induction",
  "contradiction",
  "contrapositive",
  "case_analysis",
  "extremal_principle",
  "invariant",
  "bijection",
  "generating_function",
  "algebraic_manipulation",
  "inequality_chain",
  "pigeonhole",
  "double_counting",
  "construction",
  "inclusion_exclusion",
  "subset_argument",
  "cardinality_argument",
] as const;

export type ProofTechnique = (typeof PROOF_TECHNIQUES)[number];

// ── Agent Roles (6 roles for multi-agent orchestration) ───────────────
export const AGENT_ROLES = [
  "orchestrator",
  "formalizer",
  "strategist",
  "critic",
  "prover",
  "explainer",
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

// ── Pipeline Stages ───────────────────────────────────────────────────
export type PipelineStage =
  | "idle"
  | "classifying"
  | "extracting"        // extracting optimization structure
  | "optimizing"        // deterministic optimization search
  | "nl_solving"        // generating natural language solution
  | "autoformalizing"
  | "enumerating"
  | "evaluating"
  | "computing"
  | "solving"
  | "lean_attempting"   // attempting Lean formal proof
  | "reviewing"
  | "complete"
  | "failed";

// ── Problem Type ─────────────────────────────────────────────────────
export type ProblemType = "computational" | "theorem" | "optimization" | "find_all_values";

// ── Error Kinds (8 categories for Lean repair loop) ───────────────────
export const ERROR_KINDS = [
  "unknown_identifier",
  "type_mismatch",
  "unsolved_goal",
  "tactic_failed",
  "missing_lemma",
  "scope_error",
  "syntax_error",
  "timeout",
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

// ── Build & Step Status ──────────────────────────────────────────────
export type BuildStatus = "idle" | "ok" | "fail" | "unavailable";

export type StepStatus = "pending" | "ok" | "fail" | "sorry";

// ── Method Option (with optional technique tags) ─────────────────────
export interface MethodOption {
  id: string;
  category: TaxonomyCategory;
  title: string;
  inspiration: string;
  pros: string;
  cons: string;
  lean_sketch: string;
  confidence: number;
  technique_tags?: ProofTechnique[];
  estimated_difficulty?: number; // 0-1
}

// ── Method Score (5-dimension evaluation) ─────────────────────────────
export interface MethodScore {
  method_id: string;
  feasibility: number;       // 0-1: likelihood of formal proof success
  elegance: number;          // 0-1: mathematical beauty
  lean_difficulty: number;   // 0-1: estimated Lean formalization difficulty (1=hardest)
  mathlib_coverage: number;  // 0-1: how well Mathlib covers needed lemmas
  pedagogical_value: number; // 0-1: teaching value
  composite: number;         // weighted aggregate
  rationale: string;
}

// ── Classified Error (for repair loop) ────────────────────────────────
export interface ClassifiedError {
  kind: ErrorKind;
  line?: number;
  column?: number;
  message: string;
  suggestion?: string;
  raw: string;
}

// ── Proof Step ────────────────────────────────────────────────────────
export interface ProofStep {
  index: number;
  plain_goal: string;
  lean_goal: string;
  plain_explanation: string;
  lean_code: string;
  status: StepStatus;
  build_log?: string;
  sorry_label?: SorryLabel;
}

// ── Sorry Label (graceful degradation) ────────────────────────────────
export interface SorryLabel {
  step_index: number;
  reason: string;
  lean_goal: string;
  suggested_approach: string;
}

// ── Intuition Review ──────────────────────────────────────────────────
export interface IntuitionReview {
  per_step: StepInsight[];
  overall_lessons: string[];
  transferable_patterns: string[];
}

export interface StepInsight {
  step_index: number;
  motivation: string;
  trigger_observation: string;
  discovery_path: string;
  dead_ends: string[];
  transferable_lesson: string;
}

// ── Autoformalization Validation ──────────────────────────────────────
export interface ValidationResult {
  layer: number;     // 1-5
  pass: boolean;
  detail: string;
  /**
   * True when the check could not actually run (LLM error / Lean unavailable)
   * and `pass` is a default rather than a verdict. Shown to the user so a
   * "validated" statement is never mistaken for a fully checked one.
   */
  skipped?: boolean;
}

// ── Session ───────────────────────────────────────────────────────────
export interface Session {
  id: string;
  schema_version?: number;   // for future migrations (default: 1)
  problem_text: string;
  pipeline_stage: PipelineStage;
  math_domain?: MathDomain;
  formal_statement?: string;
  formal_validated: boolean;
  validation_results: ValidationResult[];
  methods: MethodOption[];
  method_scores?: MethodScore[];
  recommended_method_id?: string;
  selected_method_id?: string;
  theorem_name?: string;
  theorem_type?: string;
  /**
   * Pretty-printed type of the validated theorem (`#check @name`), recorded
   * when autoformalization was accepted. Final verification must reproduce
   * exactly this signature, so later stages cannot silently prove a
   * different statement ("statement lock").
   */
  formal_signature?: string;
  steps: ProofStep[];
  assembled_lean: string;
  build_status: BuildStatus;
  comparison_summary?: string;
  out_of_domain_warning?: string;
  intuition_review?: IntuitionReview;
  sorry_labels: SorryLabel[];
  computation_result?: ComputationResult;
  nl_solution?: NaturalLanguageSolution;
  lean_proof_attempt?: LeanProofAttempt;
  /** What the last solve run consumed (LLM calls/tokens by role, Lean verifications, wall time). */
  metrics?: RunMetrics;
  created_at: number;
  updated_at: number;
}

// ── Grade Levels (4 tiers) ───────────────────────────────────────────
export const GRADE_LEVELS = [
  "elementary",   // 小学
  "middle",       // 初中
  "high",         // 高中
  "university",   // 大学
] as const;

export type GradeLevel = (typeof GRADE_LEVELS)[number];

// ── Difficulty Levels (3 tiers) ──────────────────────────────────────
export const DIFFICULTY_LEVELS = [
  "standard",     // 课内标准
  "advanced",     // 提高拓展
  "competition",  // 竞赛级别
] as const;

export type DifficultyLevel = (typeof DIFFICULTY_LEVELS)[number];

// ── Competition-Oriented Domains ─────────────────────────────────────
export const COMPETITION_DOMAINS = [
  "competition_elementary",
  "competition_inequality",
  "competition_number_theory",
  "competition_combinatorics",
  "competition_set_theory",
  "number_theory",
  "combinatorics",
  "set_theory",
  "algebra",
  "geometry",
  "inequality",
  "logic",
  "computation",
] as const;

export type CompetitionDomain = (typeof COMPETITION_DOMAINS)[number];

// ── Computation Result (for computational problems) ──────────────────
export interface ComputationResult {
  answer: string;
  answer_exact: string;
  answer_decimal: string;
  cross_validated: boolean;
  methods_used: string[];
  solution_steps: string[];
}

// ── Natural Language Solution ──────────────────────────────────────────
export interface NaturalLanguageSolution {
  summary: string;           // one-line answer summary (Chinese)
  steps: NLStep[];           // ordered solution steps
  final_answer: string;      // final answer with LaTeX (e.g. "$\\frac{14}{5}$")
  verification: string;      // how to verify the answer (Chinese)
}

export interface NLStep {
  title: string;             // step title (e.g. "建立方程", "求解")
  content: string;           // step content with LaTeX math (Chinese)
  substeps?: string[];       // optional sub-step breakdown
  key_formula?: string;      // highlighted key equation (LaTeX)
}

// ── Lean Proof Attempt (for computational problems) ────────────────────
export interface LeanProofAttempt {
  attempted: boolean;
  success: boolean;
  formal_statement?: string;  // the Lean theorem statement
  proof_code?: string;        // the Lean proof (if successful)
  failure_reason?: string;    // why it couldn't be formalized (Chinese)
  limitations?: string[];     // specific limitations encountered
  /** Axioms the final proof depends on (from `#print axioms`). */
  axioms?: string[];
  /** True when the proved statement matched the validated formalization. */
  statement_locked?: boolean;
  /** Which backend produced the verdict. */
  verifier?: "repl" | "spawn" | "none";
  /** How the proof was found: a one-tactic probe, the whole-proof loop, or stepwise search. */
  strategy?: "trivial" | "whole_proof" | "stepwise";
  /** Proof candidates generated (samples or step attempts). */
  attempts?: number;
  /** Whole-proof rounds run (sampling + repairs). */
  rounds?: number;
}

// ── Generated Problem ────────────────────────────────────────────────
export interface GeneratedProblem {
  id: string;
  statement: string;
  answer: string;
  hints: string[];
  grade_level: GradeLevel;
  difficulty: DifficultyLevel;
  domain: CompetitionDomain;
  suggested_techniques: ProofTechnique[];
  source_inspiration: string;
  estimated_solve_time: string;
  diagram_svg?: string;
}
