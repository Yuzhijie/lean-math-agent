/**
 * Deterministic fixes for Lean syntax the models keep producing from
 * older Mathlib / Lean 3 training data. Each rewrite is meaning-preserving
 * on current Mathlib and would otherwise be a guaranteed parse error:
 *
 *   ∑ x in s, f x          →  ∑ x ∈ s, f x        (the `in` form was removed)
 *   cases h with x hx      →  cases' h with x hx  (Lean 3 style; `cases'` is Mathlib's port)
 *   induction n with n ih  →  induction' n with n ih
 *   λ x, e                 →  fun x => e           (Lean 3 lambda)
 *
 * Structured forms (`cases h with | inl h => …`) are left alone.
 */

const BIG_OPS = "∑∏⋃⋂⨆⨅";

/** Rewrite deprecated / Lean 3 syntax in a tactic block or proof text. */
export function modernizeLeanSyntax(text: string): string {
  let out = text;

  // Big operators: `∑ x in s, f` → `∑ x ∈ s, f` (binder may carry a type ascription).
  out = out.replace(new RegExp(`([${BIG_OPS}])\\s+([^,\\n∈]+?)\\s+in\\s+`, "g"), "$1 $2 ∈ ");

  // Lean 3 style `cases h with x y` / `induction n with n ih` on one line
  // (identifiers only after `with`, no `|` alternatives).
  out = out.replace(
    /^(\s*)(cases|induction)\s+([^\n|]+?)\s+with((?:\s+[A-Za-z_][\w'₀-₉]*)+)\s*$/gm,
    (m, indent: string, tac: string, target: string, names: string) => {
      if (/^(cases'|induction')/.test(tac) || target.includes("using")) return m;
      return `${indent}${tac}' ${target} with${names}`;
    },
  );

  // Lean 3 lambda: `λ x, body` / `λ ⟨a, b⟩, body` → `fun x => body`.
  out = out.replace(/λ\s*(⟨[^⟩\n]*⟩|[^,\n=>]+?),\s*/g, "fun $1 => ");

  return out;
}
