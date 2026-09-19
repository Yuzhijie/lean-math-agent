// ── Axiom checking ────────────────────────────────────────────────────
//
// A Lean proof is only trustworthy if the kernel accepted it AND it does not
// rest on axioms we did not intend. `#print axioms <name>` lists them:
//
//   'foo' depends on axioms: [propext, Classical.choice, Quot.sound]
//   'foo' does not depend on any axioms
//
// `sorryAx` means a `sorry`/`admit` (or an elaboration error, which Lean
// also fills with sorry) is somewhere in the proof term — the "no error
// messages" check alone does NOT catch `admit`, because it only produces a
// warning. `native_decide` introduces a per-declaration axiom
// (`foo._native.native_decide.ax_1`, or `Lean.ofReduceBool` in older Lean)
// that trusts the compiler rather than the kernel.

/** The three standard axioms of Lean 4 + Mathlib that every proof may use. */
export const STANDARD_AXIOMS: ReadonlySet<string> = new Set([
  "propext",
  "Classical.choice",
  "Quot.sound",
]);

const NATIVE_AXIOM_RE = /(^|\.)(native_decide|ofReduceBool|trustCompiler)(\.|$)/;

export interface AxiomReport {
  /** Every axiom the declaration depends on, as printed by Lean. */
  axioms: string[];
  /** Subset that is not in the allowed set. */
  disallowed: string[];
  /** True when `sorryAx` is present (sorry / admit / elaboration error). */
  usesSorry: boolean;
  /** True when a compiler-trusting axiom (`native_decide`) is present. */
  usesNative: boolean;
}

/**
 * Parse the info message emitted by `#print axioms <name>`.
 * Returns undefined when the message is not an axioms line for `name`.
 */
export function parseAxiomsMessage(text: string, name: string): string[] | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const none = new RegExp(`^'${escaped}' does not depend on any axioms`);
  if (none.test(text.trim())) return [];
  const some = new RegExp(`^'${escaped}' depends on axioms: \\[([^\\]]*)\\]`);
  const m = text.trim().match(some);
  if (!m) return undefined;
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function classifyAxioms(
  axioms: string[],
  opts?: { allowNative?: boolean; extraAllowed?: Iterable<string> },
): AxiomReport {
  const allowed = new Set(STANDARD_AXIOMS);
  for (const a of opts?.extraAllowed ?? []) allowed.add(a);
  const usesSorry = axioms.includes("sorryAx");
  const usesNative = axioms.some((a) => NATIVE_AXIOM_RE.test(a));
  const disallowed = axioms.filter((a) => {
    if (allowed.has(a)) return false;
    if (opts?.allowNative && NATIVE_AXIOM_RE.test(a)) return false;
    return true;
  });
  return { axioms, disallowed, usesSorry, usesNative };
}

/**
 * Parse the info message emitted by `#check @<name>`:
 * `name : ∀ (n : ℕ), n + 0 = n` (possibly wrapped over several lines).
 * Returns the type part with whitespace normalised, or undefined.
 */
export function parseCheckMessage(text: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = text.trim().match(new RegExp(`^${escaped}\\s*:\\s*([\\s\\S]+)$`));
  if (!m) return undefined;
  return normalizeSignature(m[1]);
}

/** Collapse whitespace so two pretty-printed types compare by content. */
export function normalizeSignature(sig: string): string {
  return sig.replace(/\s+/g, " ").trim();
}
