/**
 * A theorem's binder-form type (`(a b : ℝ) (h : 0 < a) : a * b > 0`, or `: P`) as one proposition
 * (`∀ (a b : ℝ) (h : 0 < a), a * b > 0`), so that two statements of the same problem can be compared
 * inside a single Lean goal (`A ↔ B`).
 */
export function splitTopLevelColon(type: string): { binders: string; goal: string } | null {
  const t = type.trim();
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if ("([{⦃⟨".includes(c)) depth++;
    else if (")]}⦄⟩".includes(c)) depth = Math.max(0, depth - 1);
    else if (c === ":" && depth === 0 && t[i + 1] !== "=") return { binders: t.slice(0, i).trim(), goal: t.slice(i + 1).trim() };
  }
  return null;
}

export function typeToProp(type: string): string | null {
  const parts = splitTopLevelColon(type);
  if (!parts || !parts.goal) return null;
  return parts.binders ? `∀ ${parts.binders}, ${parts.goal}` : parts.goal;
}
