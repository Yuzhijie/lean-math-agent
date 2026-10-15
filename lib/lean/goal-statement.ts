/**
 * A goal state as Lean prints it, turned back into a statement, so that one hole of a proof sketch can
 * be handed to a whole-proof prover as a lemma of its own:
 *
 *   x y : ℝ                      theorem t_hole1 (x y : ℝ) (h₀ : 0 < x) [inst : Fintype α]
 *   h₀ : 0 < x            →        : x * y ≤ (x ^ 2 + y ^ 2) / 2
 *   inst✝ : Fintype α
 *   ⊢ x * y ≤ (x ^ 2 + y ^ 2) / 2
 *
 * Hypotheses keep their names (the prover's tactics are spliced back into the sketch, where the same
 * names are in scope); inaccessible names (`x✝`) get fresh ones; instance hypotheses become instance
 * binders; universe levels become `Type*`. Let-bound hypotheses (`x : T := v`) keep only their type.
 * Null when the state has more than one goal or no `⊢`. The printed state does not always reparse
 * (coercion arrows, auxiliary definitions); the caller must check that the statement elaborates.
 */
export function goalToStatement(goal: string): { binders: string[]; target: string; statement: string } | null {
  const text = goal.replace(/\r/g, "").trim();
  if (!text || (text.match(/⊢/g) ?? []).length !== 1) return null;
  const [hypText, targetText] = text.split("⊢");
  const target = targetText.replace(/\s*\n\s*/g, " ").trim();
  if (!target) return null;
  // Join continuation lines (a long type wraps onto indented lines).
  const lines: string[] = [];
  for (const raw of hypText.split("\n")) {
    if (!raw.trim()) continue;
    if (/^\s/.test(raw) && lines.length) lines[lines.length - 1] += " " + raw.trim();
    else lines.push(raw.trim());
  }
  const binders: string[] = [];
  let fresh = 0;
  for (const line of lines) {
    const m = /^(.+?)\s*:\s*(.+)$/.exec(line);
    if (!m) return null;
    let type = m[2].replace(/\s*:=.*$/, "").trim();
    type = type.replace(/\bType u_\d+\b/g, "Type*").replace(/\bSort u_\d+\b/g, "Sort*");
    const names = m[1].split(/\s+/).filter(Boolean);
    const instance = names.every((n) => /^inst✝\d*$/.test(n));
    if (instance) {
      for (const _ of names) binders.push(`[${type}]`);
      continue;
    }
    const clean = names.map((n) => (/✝/.test(n) ? `h_aux${++fresh}` : n));
    binders.push(`(${clean.join(" ")} : ${type})`);
  }
  return { binders, target, statement: `${binders.join(" ")}${binders.length ? " " : ""}: ${target}` };
}
