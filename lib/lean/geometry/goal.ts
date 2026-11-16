/**
 * A goal as the REPL prints it — hypotheses `names : type` (long types continue on indented
 * lines; let-bound ones end in `:= value`) and `⊢ target` — split into its parts.
 *
 * Lean breaks a term that is longer than the line (120 characters), wherever it fits: after a
 * `∧`, inside a sum. Where it breaks depends on how long the names are, not on what is said — so
 * the parts come back on one line each (every run of white space one space): a rule that looks
 * for ` ∧ ` finds it whether the goal was `(d e f : ℝ)` or `(a_1 b_1 c_1 : ℝ)` (measured by
 * `npm run lean:variants`: the AM–GM statement with longer names was not split at its `∧`).
 */
export interface Hyp {
  names: string[];
  type: string;
  /** Let-bound: the value after `:=`. */
  value?: string;
}

export interface GoalState {
  hyps: Hyp[];
  target: string;
}

/** A printed term on one line: a line break and its indentation are one space. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function parseGoal(text: string): GoalState | null {
  // a goal made by `refine ⟨?_, ?_⟩` / `constructor` starts with its tag: `case refine_1`
  const t = text.replace(/\r/g, "").replace(/^case [^\n]*\n/, "");
  const at = t.indexOf("⊢");
  if (at < 0 || t.indexOf("⊢", at + 1) >= 0) return null;
  const target = oneLine(t.slice(at + 1));
  const lines: string[] = [];
  for (const raw of t.slice(0, at).split("\n")) {
    if (!raw.trim()) continue;
    if (/^\s/.test(raw) && lines.length) lines[lines.length - 1] += "\n" + raw;
    else lines.push(raw);
  }
  const hyps: Hyp[] = [];
  for (const line of lines) {
    const m = /^(\S[^:]*?)\s*:\s([\s\S]*)$/.exec(line);
    if (!m) return null;
    const names = m[1].trim().split(/\s+/);
    let type = m[2];
    let value: string | undefined;
    const def = splitTopLevel(type, ":=");
    if (def) {
      type = def[0];
      value = oneLine(def[1]);
    }
    hyps.push({ names, type: oneLine(type), ...(value !== undefined ? { value } : {}) });
  }
  return { hyps, target };
}

/** Split at the first `sep` outside parentheses. */
function splitTopLevel(s: string, sep: string): [string, string] | null {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{" || c === "⟨") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === "⟩") depth--;
    else if (depth === 0 && s.startsWith(sep, i)) return [s.slice(0, i), s.slice(i + sep.length)];
  }
  return null;
}

/** Names Lean shows as inaccessible (`h✝`, `w✝¹`). */
export function isInaccessible(name: string): boolean {
  return name.includes("✝");
}
