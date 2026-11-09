/**
 * A proof that failed only on names Lean does not know, repaired without the model: each unknown
 * identifier gets one replacement, and the caller verifies the result once.
 *
 *   1. renames (renamed.ts: the hand table and the one generated from Mathlib's @[deprecated]
 *      history) — normally applied before verification already; here for names that reached the
 *      verifier another way;
 *   2. a declaration of the premise index with the same last component in another namespace
 *      (`sq_sqrt` → `Real.sq_sqrt`, `Nat.add_sub_cancel'` → `add_sub_cancel'`);
 *   3. Mathlib's systematic renames that the generated table may miss for a name it never saw
 *      (a model's guess built the old way): not_mem → notMem, nat_cast → natCast, …, `_iff` → `_iff₀`.
 *
 * Nothing is trusted: the repaired proof goes through the same verification as any other.
 */
import { similarNames } from "./premises";
import { renamedTo } from "./renamed";

const PATTERNS: [RegExp, string][] = [
  [/not_mem/g, "notMem"],
  [/nat_cast/g, "natCast"],
  [/int_cast/g, "intCast"],
  [/rat_cast/g, "ratCast"],
  [/coe_nat/g, "natCast"],
  [/coe_int/g, "intCast"],
  [/_iff(')?$/, "_iff₀$1"],
  [/_le_iff(')?$/, "_le_iff₀$1"],
];

/** Candidate names for one unknown identifier, most likely first (none known to exist). */
export function nameVariants(id: string): string[] {
  const out: string[] = [];
  for (const [re, to] of PATTERNS) {
    const v = id.replace(re, to);
    if (v !== id && !out.includes(v)) out.push(v);
  }
  // all of them at once (not_mem … _iff)
  let all = id;
  for (const [re, to] of PATTERNS) all = all.replace(re, to);
  if (all !== id && !out.includes(all)) out.unshift(all);
  return out;
}

/** The replacement for one unknown identifier, or undefined. */
export async function replacementFor(id: string): Promise<string | undefined> {
  const renamed = renamedTo(id);
  if (renamed) return renamed;
  const tail = id.split(".").pop() ?? id;
  try {
    const hits = await similarNames(id, 5);
    const same = hits.find((p) => p.name !== id && (p.name.split(".").pop() ?? p.name) === tail);
    if (same) return same.name;
    // a systematic rename the index knows (not_mem → notMem …)
    for (const v of nameVariants(id)) {
      const vt = v.split(".").pop() ?? v;
      const hit = (await similarNames(v, 5)).find((p) => p.name === v || (p.name.split(".").pop() ?? p.name) === vt);
      if (hit) return hit.name;
    }
  } catch {
    // no index: fall through to the systematic renames, unchecked
  }
  return nameVariants(id)[0];
}

const ID_CHAR = "[A-Za-z0-9_'.!?\\u2080-\\u2089]";
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The tactics with every unknown identifier that has a replacement replaced, or undefined. */
export async function repairUnknownNames(tactics: string, unknown: string[]): Promise<{ tactics: string; replaced: [string, string][] } | undefined> {
  const replaced: [string, string][] = [];
  let out = tactics;
  for (const id of [...new Set(unknown)].slice(0, 6)) {
    const to = await replacementFor(id);
    if (!to || to === id) continue;
    const re = new RegExp(`(?<!${ID_CHAR})${escape(id)}(?!${ID_CHAR})`, "g");
    if (!re.test(out)) continue;
    out = out.replace(re, to);
    replaced.push([id, to]);
  }
  return replaced.length ? { tactics: out, replaced } : undefined;
}
