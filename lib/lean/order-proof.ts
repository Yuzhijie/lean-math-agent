/**
 * "Smallest n with m ∣ a ^ n - 1" and "smallest m" with a small bound: proofs the program writes
 * from the multiplicative orders (strategy "order") and by letting the kernel check every number
 * below the bound (strategy "bounded"), and the advice the model gets for the same statements
 * (orderHint). Two stages of the prover table (lib/lean/prover-stages.ts); pure — statements
 * in, tactic scripts out.
 */
import { hugePower } from "../compute/nat-expr";

// ── "Smallest n with m ∣ a ^ n - 1": multiplicative orders ─────────────────

export interface OrderCondition {
  /** As written, e.g. "(3 : ℕ) ^ 5 ∣ (2 : ℕ) ^ n - 1". */
  text: string;
  modulus: number;
  base: number;
  /** The multiplicative order of base mod modulus: m ∣ a ^ n - 1 ⇔ order ∣ n. */
  order: number;
  /** A prime-power part of a composite modulus as written (`257175` for 81, 25, 127). */
  partOf?: string;
  /** How the condition is written: `M ∣ a ^ n - 1` (or a helper / padicValNat), a congruence `≡ 1` / `% M = 1 % M`, or `a ^ n % M = 1`. */
  form?: "dvd" | "modeq" | "mod1";
  /** The modulus as written in the statement (for `mod1`). */
  modText?: string;
}

const NUM = String.raw`\(?\s*(\d+)\s*(?::\s*(?:ℕ|ℤ|Nat|Int)\s*)?\)?`;
/** `v (a ^ n - 1) e`-style valuation conditions: `padicValNat 3 (2 ^ n - 1) = 5`, or a helper such as `ExactValuation 3 (2 ^ m - 1) 5` (p ^ e ∣ …). */
const PADIC_ATOM = new RegExp(String.raw`(¬\s*\(*\s*)?padicValNat\s+${NUM}\s+\(\s*${NUM}\s*\^\s*([a-z]\w*)\s*-\s*1\s*\)\s*(=|≥)\s*(\d+)`, "g");
const HELPER_ATOM = new RegExp(String.raw`(¬\s*\(*\s*)?\b([A-Za-z_][\w']*)\s+${NUM}\s+\(\s*${NUM}\s*\^\s*([a-z]\w*)\s*-\s*1\s*\)\s+(\d+)`, "g");
/** A product modulus `(3 ^ 4 * 5 ^ 2 * 127 : ℕ) ∣ 2 ^ m - 1` (parenthesised or not). */
const FACTOR = String.raw`\d+(?:\s*\^\s*\d+)?`;
const PRODUCT_ATOM = new RegExp(String.raw`(¬\s*\(*\s*)?\(?\s*(${FACTOR}(?:\s*\*\s*${FACTOR})+)\s*(?::\s*(?:ℕ|ℤ|Nat|Int)\s*)?\)?\s*∣\s*\(?\s*${NUM}\s*\^\s*([a-z]\w*)\s*\)?\s*-\s*1\b`, "g");

/** Value of `3 ^ 4 * 5 ^ 2 * 127`. */
function productValue(expr: string): bigint {
  return expr
    .split("*")
    .map((f) => f.split("^").map((x) => BigInt(x.trim())))
    .reduce((acc, [b, e]) => acc * b ** (e ?? 1n), 1n);
}

/** The prime of a prime power. */
function primeOf(q: bigint): bigint {
  for (let p = 2n; p * p <= q; p++) if (q % p === 0n) return p;
  return q;
}

/** Prime-power factors of n (trial division; undefined when a factor above 10^6 is left over). */
export function primePowers(n: bigint): bigint[] | undefined {
  const out: bigint[] = [];
  let m = n;
  for (let p = 2n; p * p <= m; p++) {
    if (p > 1_000_000n) return undefined;
    if (m % p) continue;
    let q = 1n;
    while (m % p === 0n) {
      m /= p;
      q *= p;
    }
    out.push(q);
  }
  if (m > 1n) out.push(m);
  return out;
}

/**
 * A modulus written at `i`: a number, `3 ^ 5`, or a product in parentheses
 * (`((3 : ℕ) ^ 6 * 5 ^ 3 * 7 ^ 2)`); its value, and where it ends.
 */
function modulusAt(t: string, i: number, opts: { bareProduct?: boolean } = {}): { value: bigint; end: number; text: string } | undefined {
  let j = i;
  while (t[j] === " ") j++;
  let text: string;
  if (t[j] === "(") {
    let depth = 0;
    let k = j;
    for (; k < t.length; k++) {
      if (t[k] === "(") depth++;
      else if (t[k] === ")" && --depth === 0) break;
    }
    if (k >= t.length) return undefined;
    text = t.slice(j, k + 1);
    j = k + 1;
  } else {
    // after `%` a bare product binds wrongly (`a % 3 ^ 5 * 5 ^ 3` is `(a % 3 ^ 5) * 5 ^ 3`)
    const m = (opts.bareProduct === false ? /^\d+(?:\s*\^\s*\d+)?/ : /^\d+(?:\s*\^\s*\d+)?(?:\s*\*\s*\d+(?:\s*\^\s*\d+)?)*/).exec(t.slice(j));
    if (!m) return undefined;
    text = m[0];
    j += m[0].length;
  }
  const clean = text.replace(/:\s*(?:ℕ|ℤ|Nat|Int)/g, "").replace(/[()]/g, "").trim();
  if (!/^\d+(?:\s*\^\s*\d+)?(?:\s*\*\s*\d+(?:\s*\^\s*\d+)?)*$/.test(clean)) return undefined;
  return { value: productValue(clean), end: j, text: text.trim() };
}

/** `a ^ n` with a variable exponent, possibly cast: `2 ^ n`, `(2 ^ n : ℕ)`, `((2 : ℕ) ^ n)`. */
const VAR_POW = String.raw`\(?\s*\(?\s*(\d+)\s*(?::\s*(?:ℕ|Nat)\s*)?\)?\s*\^\s*([a-z]\w*)\s*(?::\s*(?:ℕ|Nat)\s*)?\)?`;

/**
 * Congruences `a ^ n ≡ 1` written as `Nat.ModEq M (a ^ n) 1`, `a ^ n ≡ 1 [MOD M]` or
 * `a ^ n % M = 1 % M` (also `= 1`): the same condition as `M ∣ a ^ n - 1`.
 */
type CongruenceAtom = { text: string; value: bigint; base: string; v: string; negated: boolean; form: "modeq" | "mod1"; modText: string };
function congruenceAtoms(t: string): CongruenceAtom[] {
  const out: CongruenceAtom[] = [];
  const neg = (at: number) => /¬\s*\(*\s*$/.test(t.slice(Math.max(0, at - 12), at));
  // `3 * 2 ^ n % 7`, `f 2 ^ n` are not `2 ^ n …`: nothing may be applied to the power on the left
  const freeLeft = (at: number) => {
    while (t[at] === " ") at++; // a match may start at the space before the power
    return !/(?:[*\/%]|[\w')\]])\s*\(*\s*$/.test(t.slice(Math.max(0, at - 8), at));
  };
  // and the condition ends there (`= 1 + k` is not `= 1`)
  const ends = (at: number) => /^\s*(?:$|[)∧∨→↔,\]])/.test(t.slice(at));
  for (const m of t.matchAll(/Nat\.ModEq\s+/g)) {
    const mod = modulusAt(t, m.index! + m[0].length);
    if (!mod) continue;
    const rest = new RegExp(String.raw`^\s*${VAR_POW}\s+1\b`).exec(t.slice(mod.end));
    if (rest && ends(mod.end + rest[0].length)) out.push({ text: t.slice(m.index!, mod.end + rest[0].length), value: mod.value, base: rest[1], v: rest[2], negated: neg(m.index!), form: "modeq", modText: mod.text });
  }
  for (const m of t.matchAll(new RegExp(String.raw`${VAR_POW}\s*≡\s*1\s*\[MOD\s*`, "g"))) {
    if (!freeLeft(m.index!)) continue;
    const mod = modulusAt(t, m.index! + m[0].length);
    if (mod && /^\s*\]/.test(t.slice(mod.end))) out.push({ text: t.slice(m.index!, mod.end), value: mod.value, base: m[1], v: m[2], negated: neg(m.index!), form: "modeq", modText: mod.text });
  }
  for (const m of t.matchAll(new RegExp(String.raw`${VAR_POW}\s*%\s*`, "g"))) {
    if (!freeLeft(m.index!)) continue;
    const mod = modulusAt(t, m.index! + m[0].length, { bareProduct: false });
    if (!mod) continue;
    const eq = /^\s*=\s*1\b/.exec(t.slice(mod.end));
    if (!eq) continue;
    let end = mod.end + eq[0].length;
    const pct = /^\s*%\s*/.exec(t.slice(end));
    const form: "modeq" | "mod1" = pct ? "modeq" : "mod1";
    if (pct) {
      const again = modulusAt(t, end + pct[0].length, { bareProduct: false });
      if (!again || again.value !== mod.value) continue;
      end = again.end;
    }
    if (ends(end)) out.push({ text: t.slice(m.index!, end), value: mod.value, base: m[1], v: m[2], negated: neg(m.index!), form, modText: mod.text });
  }
  return out;
}

const ORDER_ATOM = new RegExp(String.raw`(¬\s*\(*\s*)?\(?\s*${NUM}(?:\s*\^\s*(\d+))?\s*\)?\s*∣\s*\(?\s*${NUM}\s*\^\s*([a-z]\w*)\s*\)?\s*-\s*1\b`, "g");

/** Multiplicative order of a mod m (a, m coprime), or undefined when too large to search. */
export function multiplicativeOrder(a: number, m: number, cap = 2_000_000): number | undefined {
  if (m < 2) return undefined;
  const g = (x: number, y: number): number => (y ? g(y, x % y) : x);
  if (g(a % m, m) !== 1) return undefined;
  let x = a % m;
  for (let k = 1; k <= cap; k++) {
    if (x === 1) return k;
    x = Number((BigInt(x) * BigInt(a)) % BigInt(m));
  }
  return undefined;
}

/**
 * The positive conditions `m ∣ a ^ n - 1` (variable exponent) of a statement that also asks for the
 * smallest such n (`→ B ≤ n`, `n ≥ B`, `IsLeast`). Brute force over all n < B times out when B is
 * large; the orders make it a divisibility argument.
 */
export function orderConditions(t: string): OrderCondition[] | undefined {
  // "smallest": `→ B ≤ n`, `n ≥ B`, `IsLeast`, or `n < B → ¬ …`
  if (!/→\s*\d+\s*≤\s*[a-z]\w*|[a-z]\w*\s*≥\s*\d+|IsLeast|[a-z]\w*\s*<\s*\d+\s*→/.test(t)) return undefined;
  const out: OrderCondition[] = [];
  // A composite modulus is split into prime powers: their orders are small, while the order mod
  // the whole number can be large enough that `decide` over r < k hits Lean's recursion limit.
  const add = (text: string, value: bigint, b: string, form: OrderCondition["form"] = "dvd", modText?: string) => {
    const base = Number(b);
    const parts = primePowers(value);
    if (!parts?.length) return;
    for (const q of parts) {
      const modulus = Number(q);
      if (!Number.isSafeInteger(modulus) || modulus > 10_000_000 || out.some((o) => o.modulus === modulus && o.base === base)) continue;
      const order = multiplicativeOrder(base, modulus);
      if (order) out.push({ text: text.trim(), modulus, base, order, form, ...(modText ? { modText } : {}), ...(parts.length > 1 ? { partOf: value.toString() } : {}) });
    }
  };
  // a helper (let-defined) whose definition says p ^ e ∣ m
  const helpers = new Set([...t.matchAll(/let\s+([A-Za-z_][\w']*)\s*:[^:=]*:=\s*fun\s+(\w+)\s+(\w+)\s+(\w+)\s*=>\s*\2\s*\^\s*\4\s*∣\s*\3/g)].map((m) => m[1]));
  let atoms: { text: string; p: string; e?: string; base: string; v: string; negated: boolean; value?: bigint; form?: "modeq" | "mod1"; modText?: string }[] = [
    ...[...t.matchAll(PRODUCT_ATOM)].map((m) => ({ text: m[0], p: m[2], value: productValue(m[2]), base: m[3], v: m[4], negated: !!m[1] })),
    ...[...t.matchAll(ORDER_ATOM)].map((m) => ({ text: m[0], p: m[2], e: m[3], base: m[4], v: m[5], negated: !!m[1] })),
    ...[...t.matchAll(PADIC_ATOM)].map((m) => ({ text: m[0], p: m[2], e: m[6], base: m[3], v: m[4], negated: !!m[1] })),
    ...[...t.matchAll(HELPER_ATOM)].filter((m) => helpers.has(m[2])).map((m) => ({ text: m[0], p: m[3], e: m[6], base: m[4], v: m[5], negated: !!m[1] })),
    ...congruenceAtoms(t).map((c) => ({ ...c, p: c.value.toString() })),
  ];
  // only conditions on the variable being minimised (`B ≤ n`, `n < B →`, `IsLeast {n : ℕ | …}`)
  const minVar = /→\s*\d+\s*≤\s*([a-z]\w*)/.exec(t)?.[1] ?? /([a-z]\w*)\s*<\s*\d+\s*→/.exec(t)?.[1] ?? /([a-z]\w*)\s*≥\s*\d+/.exec(t)?.[1] ?? /IsLeast\s*\{\s*([a-z]\w*)/.exec(t)?.[1];
  if (minVar) atoms = atoms.filter((a) => a.v === minVar);
  // ORDER_ATOM also matches the last factor of a product (`127 ∣ 2 ^ m - 1` inside `3 ^ 4 * 5 ^ 2 * 127 ∣ …`).
  const productTexts = atoms.filter((a) => a.value !== undefined).map((a) => a.text);
  for (let i = atoms.length - 1; i >= 0; i--) {
    if (atoms[i].value === undefined && productTexts.some((p) => p !== atoms[i].text && p.includes(atoms[i].text.trim()))) atoms.splice(i, 1);
  }
  // `¬ p ^ (e+1) ∣ …` next to `p ^ e ∣ …` is the "exactly e" half and does not constrain n; a negated
  // conjunction (`n < B → ¬ (… ∧ …)`) does, through each of its conditions.
  const positive = atoms.filter((a) => !a.negated);
  const primesOf = (a: (typeof atoms)[number]) => new Set((primePowers(a.value ?? BigInt(a.p) ** BigInt(a.e ?? "1")) ?? []).map(primeOf));
  for (const a of atoms) {
    if (a.negated) {
      const mine = primesOf(a);
      if (positive.some((q) => q.base === a.base && [...primesOf(q)].some((p) => mine.has(p)))) continue;
    }
    add(a.text, a.value ?? BigInt(a.p) ** BigInt(a.e ?? "1"), a.base, a.form ?? "dvd", a.modText);
  }
  return out.length ? out : undefined;
}

const ORD_LEMMA = [
  "have ord : ∀ a m k n : ℕ, 0 < a → 0 < k → a ^ k % m = 1 → (∀ r < k, a ^ r % m = 1 → r = 0) → m ∣ a ^ n - 1 → k ∣ n := by",
  "  intro a m k n ha hk0 hk hmin h",
  "  have h1 : a ^ n % m = 1 % m := ((Nat.modEq_iff_dvd' (Nat.one_le_pow _ _ ha)).mpr h).symm",
  "  have hm : 1 % m = 1 := by rw [← hk, Nat.mod_mod]",
  "  have h2 : a ^ n % m = a ^ (n % k) % m := by",
  "    conv_lhs => rw [← Nat.div_add_mod n k, pow_add, pow_mul, Nat.mul_mod, Nat.pow_mod, hk, one_pow, hm, one_mul, Nat.mod_mod]",
  "  exact Nat.dvd_of_mod_eq_zero (hmin _ (Nat.mod_lt _ hk0) (by rw [← h2, h1, hm]))",
];

/** Largest order the program-written proof checks with `decide +kernel` over r < k. */
const ORDER_SCRIPT_MAX = 5000;

/**
 * Exponents above 2^24 (Lean's limit for computing a power) in `t`, each as N = d * e + r with
 * d, e, r below it, so `a ^ N` can be rewritten `(a ^ d) ^ e * a ^ r` before the kernel computes.
 * Undefined when that is not safe: an exponent that is not a plain literal (`2 ^ (N * 2)` — the
 * rewrite would miss it and the kernel would meet the whole power), or a power whose value would
 * have more than 2^27 bits (the kernel builds the number; far beyond that it runs out of memory).
 */
export function bigExponents(t: string): { n: string; d: string; e: string; r: string }[] | undefined {
  const out = new Map<string, { n: string; d: string; e: string; r: string }>();
  for (const m of t.matchAll(/(\d+)?\s*(?::\s*ℕ\s*)?\)?\s*\^\s*(\(?)\s*(\d+)(\s*\)?)(\s*[*+\-/^%])?/g)) {
    const n = BigInt(m[3]);
    if (n <= 1n << 24n) continue;
    // `^ (N` must close right after the literal (`^ (N * 2)` is not N); `^ N ^ k` is a tower
    if (m[2] && !m[4].includes(")")) return undefined;
    if (!m[2] && /\^/.test(m[5] ?? "")) return undefined;
    const base = m[1] ? Number(m[1]) : 2;
    if (Number(n) * Math.log2(Math.max(2, base)) > 2 ** 27) return undefined;
    let d = BigInt(Math.floor(Math.sqrt(Number(n))));
    while (d * d > n) d--;
    while ((d + 1n) * (d + 1n) <= n) d++;
    const e = n / d;
    out.set(m[3], { n: m[3], d: d.toString(), e: e.toString(), r: (n - d * e).toString() });
  }
  return [...out.values()];
}

/** Where a condition `q ∣ a ^ n - 1` can sit in a hypothesis with `depth` conjunctions: itself, a conjunct, or the first half of a helper. */
function hypPaths(depth: number): string[] {
  return [
    ...new Set(
      Array.from({ length: Math.min(6, depth) + 1 }, (_, k) => {
        const rest = ".2".repeat(k);
        return [`${rest}.1`, rest]; // the k-th conjunct, or what is left after k of them
      })
        .flat()
        .flatMap((p) => [p, `${p}.1`]),
    ),
  ];
}

/**
 * Proofs the program writes itself for "the smallest n with m ∣ a ^ n - 1 …": the statement's closed
 * facts by `decide +kernel`, then one order lemma per prime power and their lcm. Shapes: `… ∧ ∀ n,
 * 0 < n → P n → B ≤ n` (P one hypothesis or several curried ones) and `… ∀ n, 0 < n → n < B → ¬ P n`.
 * Checked in Lean 4.33.1 + Mathlib for the forms in the tests; Lean decides whether a candidate fits.
 */
export function orderProofScripts(theoremType: string): string[] {
  const t = theoremType.replace(/^\s*:\s*/, "");
  const all = orderConditions(t);
  // the script's `decide +kernel` over r < k must stay small
  const orders = all?.filter((o) => o.order <= ORDER_SCRIPT_MAX);
  if (!orders?.length || orders.length !== all?.length) return [];
  const big = bigExponents(t);
  if (!big) return [];
  const g = (x: number, y: number): number => (y ? g(y, x % y) : x);
  const l = orders.reduce((acc, o) => (acc / g(acc, o.order)) * o.order, 1);
  const lets = [...t.matchAll(/(?:^|;\s*|\(\s*)let\s+([A-Za-z_][\w']*)/g)].map((m) => m[1]);
  const script = (hyps: string[], lt: boolean) => {
    // The condition turned into `M ∣ a ^ n - 1` the way it is written (only that conversion: a
    // wrong one can be logged by Lean instead of failing, and `first` would stop there), then the
    // prime-power part q ∣ M.
    const asDvd = (o: OrderCondition, e: string) =>
      o.form === "modeq"
        ? `((Nat.modEq_iff_dvd' (Nat.one_le_pow _ _ (by norm_num))).mp (${e}).symm)`
        : o.form === "mod1"
          ? `((Nat.modEq_iff_dvd' (Nat.one_le_pow _ _ (by norm_num))).mp ((${e}).trans (Nat.mod_eq_of_lt (show (1 : ℕ) < ${o.modText} by norm_num)).symm).symm)`
          : e;
    const pick = (o: OrderCondition) =>
      `first | ${hyps.flatMap((h) => hypPaths(depth).map((p) => `(refine Nat.dvd_trans ?_ ${asDvd(o, `${h}${p}`)}; norm_num; done)`)).join(" | ")}`;
    const lcmExpr = orders.slice(1).reduce((acc, o) => `Nat.lcm (${acc}) ${o.order}`, String(orders[0].order));
    const lcmProof = orders.slice(1).reduce((acc, _o, i) => `Nat.lcm_dvd (${acc}) o${i + 1}`, "o0");
    return [
      ...(lets.length ? [`intro ${lets.join(" ")}`] : []),
      ...ORD_LEMMA,
      // every closed conjunct (however many) by the kernel; what is left is the "no smaller n" part
      "and_intros",
      // a power too big for the kernel (exponent above 2^24) is split, a ^ N = (a ^ d) ^ e * a ^ r,
      // and only the split goal goes to the kernel — never the power as written
      ...(big.length
        ? big.map(({ n, d, e, r }) => `all_goals try (rw [show (${n} : ℕ) = ${d} * ${e} + ${r} by norm_num, pow_add, pow_mul]; decide +kernel)`)
        : ["all_goals try decide +kernel"]),
      `intro n hn ${lt ? "hlt " : ""}${hyps.join(" ")}`,
      ...orders.map(
        (o, i) => `have o${i} : ${o.order} ∣ n := ord ${o.base} ${o.modulus} ${o.order} n (by norm_num) (by norm_num) (by decide +kernel) (by decide +kernel) (by ${pick(o)})`,
      ),
      `have hl : ${l} ∣ n := by`,
      `  have := ${lcmProof}`,
      `  rwa [show ${lcmExpr} = ${l} by norm_num] at this`,
      lt ? "exact absurd (Nat.le_of_dvd hn hl) (Nat.not_le.mpr hlt)" : "exact Nat.le_of_dvd hn hl",
    ].join("\n");
  };
  const ltForm = /<\s*\d+\s*→\s*¬/.test(t);
  const names = ["h", "h2", "h3", "h4"];
  // The hypotheses after `0 < n →`: how many (curried) and how deeply they are conjunctions.
  const seg = /0\s*<\s*[a-z]\w*\s*→([\s\S]*?)→\s*\d+\s*≤\s*[a-z]\w*\s*$/.exec(t)?.[1] ?? /<\s*\d+\s*→\s*¬([\s\S]*)$/.exec(t)?.[1];
  // (a let-defined predicate hides its conjunctions: then every depth)
  const depth = seg && !lets.length ? (seg.match(/∧/g) ?? []).length : 6;
  const count = seg && !ltForm ? Math.min(4, Math.max(1, seg.split("→").length)) : undefined;
  if (ltForm) return [script(["h"], true)];
  if (count) return [script(names.slice(0, count), false)];
  return [1, 2, 3, 4].slice(0, Math.max(1, Math.min(4, orders.length))).map((k) => script(names.slice(0, k), false));
}

/**
 * "The smallest m with P m is B" where B is small: the kernel checks every m below B
 * (`have key : ∀ m : ℕ, m < B → (P m → False) := by decide +kernel`), then each m ≥ B is fine.
 * For `… ∧ ∀ m : ℕ, H₁ → H₂ → B ≤ m` with decidable hypotheses, B ≤ 2000; checked in Lean 4.33.1 +
 * Mathlib (2025 ∣ m² − 1 over ℤ, B = 649; 7 ∣ 2 ^ n − 1, B = 3; two curried hypotheses, B = 2).
 */
export function boundedMinScripts(theoremType: string): string[] {
  const t = theoremType.replace(/^\s*:\s*/, "").trim();
  const m = /∀\s*([a-z]\w*)\s*:\s*(?:ℕ|Nat)\s*,\s*([\s\S]*?)→\s*(\d+)\s*≤\s*\1\s*\)*\s*$/.exec(t);
  if (!m) return [];
  const [, v, rawBody, bound] = m;
  const body = rawBody.trim();
  const B = Number(bound);
  // the kernel walks m < B by recursion: it stops with "deep recursion detected" between 2500 and
  // 3000 (Lean 4.33.1), so B stays at 2000 or below
  const cap = 2000;
  if (!Number.isSafeInteger(B) || B < 1 || B > cap || hugePower(t)) return [];
  let depth = 0;
  for (const c of body) {
    if ("([{⟨".includes(c)) depth++;
    else if (")]}⟩".includes(c) && --depth < 0) return [];
  }
  if (depth !== 0 || !body) return [];
  const lets = [...t.matchAll(/(?:^|;\s*|\(\s*)let\s+([A-Za-z_][\w']*)/g)].map((x) => x[1]);
  const close = [1, 2, 3, 4].map((k) => {
    const xs = ["a", "b", "c", "d"].slice(0, k).join(" ");
    return `exact fun ${xs} => (this ${xs}).elim`;
  });
  return [
    [
      ...(lets.length ? [`intro ${lets.join(" ")}`] : []),
      `have key : ∀ ${v} : ℕ, ${v} < ${B} → (${body} → False) := by decide +kernel`,
      "and_intros",
      "all_goals try decide +kernel",
      `intro ${v}`,
      `by_cases hlt : ${v} < ${B}`,
      `· have := key ${v} hlt`,
      `  first | ${close.join(" | ")}`,
      "· intros",
      "  exact Nat.le_of_not_lt hlt",
    ].join("\n"),
  ];
}

export function orderHint(orders: OrderCondition[]): string {
  const g = (x: number, y: number): number => (y ? g(y, x % y) : x);
  const l = orders.reduce((acc, o) => (acc / g(acc, o.order)) * o.order, 1);
  return [
    `"Smallest n" with \`m ∣ a ^ n - 1\` conditions: do NOT check every n below the bound (\`interval_cases\`, \`decide\` over n < B time out — "Lean REPL command timed out"). Use multiplicative orders: m ∣ a ^ n - 1 holds exactly when ord ∣ n. Here (computed):`,
    ...orders.map(
      (o) =>
        `- \`${o.modulus} ∣ ${o.base} ^ n - 1\` ⇔ \`${o.order} ∣ n\` (${o.order} = order of ${o.base} mod ${o.modulus})` +
        (o.partOf ? ` — a part of ${o.partOf}: get it with \`Nat.dvd_trans (by norm_num) h\` from \`h : … ∣ ${o.base} ^ n - 1\`` : ""),
    ),
    ...(orders.some((o) => o.partOf)
      ? ["- a composite modulus: work with each prime-power part as above, never with the order mod the whole number (`decide` over r < k with k in the thousands hits \"maximum recursion depth\")."]
      : []),
    ...(orders.length > 1 ? [`- together: the lcm ${l} divides n, so n ≥ ${l}.`] : []),
    "A proof that Lean accepts (adapt the numbers):",
    "```lean",
    "  have ord : ∀ a m k n : ℕ, 0 < a → 0 < k → a ^ k % m = 1 → (∀ r < k, a ^ r % m = 1 → r = 0) → m ∣ a ^ n - 1 → k ∣ n := by",
    "    intro a m k n ha hk0 hk hmin h",
    "    have h1 : a ^ n % m = 1 % m := ((Nat.modEq_iff_dvd' (Nat.one_le_pow _ _ ha)).mpr h).symm",
    "    have hm : 1 % m = 1 := by rw [← hk, Nat.mod_mod]",
    "    have h2 : a ^ n % m = a ^ (n % k) % m := by",
    "      conv_lhs => rw [← Nat.div_add_mod n k, pow_add, pow_mul, Nat.mul_mod, Nat.pow_mod, hk, one_pow, hm, one_mul, Nat.mod_mod]",
    "    exact Nat.dvd_of_mod_eq_zero (hmin _ (Nat.mod_lt _ hk0) (by rw [← h2, h1, hm]))",
    "  -- closed facts about the answer (huge powers are fine for the kernel): one `by decide +kernel` per conjunct",
    "  refine ⟨⟨by decide +kernel, by decide +kernel, …⟩, ?_⟩",
    "  rintro n hn ⟨h3, -, h5, -, h7, -⟩   -- with a helper `ExactValuation p m e := p ^ e ∣ m ∧ …`: `rintro n hn hlt ⟨⟨h3, -⟩, ⟨h5, -⟩, ⟨h7, -⟩⟩`",
    "  have a := ord 2 243 162 n (by norm_num) (by norm_num) (by norm_num) (by decide +kernel) (by simpa using h3)",
    "  -- … one per condition (b, c), then",
    "  have hl := Nat.lcm_dvd (Nat.lcm_dvd a b) c",
    "  rw [show Nat.lcm (Nat.lcm 162 100) 21 = 56700 by norm_num] at hl",
    "  exact Nat.le_of_dvd hn hl   -- for `n < 56700 → ¬ …`: exact absurd (Nat.le_of_dvd hn hl) (Nat.not_le.mpr hlt)",
    "```",
    "Do not finish with `omega` or `simp_all` while `let` definitions about these huge powers are in context: they unfold them and run out of heartbeats.",
  ].join("\n");
}
