/** Value of a closed natural-number expression (digits, + - * ^ and parentheses, optional `: ℕ` ascriptions); undefined otherwise. */
export function evalNatExpr(src: string): bigint | undefined {
  const text = src.replace(/\(\s*(\d+)\s*:\s*(?:ℕ|Nat|ℤ|Int)\s*\)/g, "$1").replace(/\s+/g, "");
  if (!/^[\d+\-*^()]+$/.test(text)) return undefined;
  let i = 0;
  const LIMIT = 10n ** 60n;
  const atom = (): bigint | undefined => {
    if (text[i] === "(") {
      i++;
      const v = sum();
      if (text[i] !== ")") return undefined;
      i++;
      return v;
    }
    const m = /^\d+/.exec(text.slice(i));
    if (!m) return undefined;
    i += m[0].length;
    return BigInt(m[0]);
  };
  const power = (): bigint | undefined => {
    const b = atom();
    if (b === undefined) return undefined;
    if (text[i] !== "^") return b;
    i++;
    const e = power();
    if (e === undefined || e > 400n) return undefined;
    const v = b ** e;
    return v > LIMIT ? undefined : v;
  };
  const product = (): bigint | undefined => {
    let v = power();
    while (v !== undefined && text[i] === "*") {
      i++;
      const r = power();
      v = r === undefined ? undefined : v * r;
    }
    return v;
  };
  const sum = (): bigint | undefined => {
    let v = product();
    while (v !== undefined && (text[i] === "+" || text[i] === "-")) {
      const op = text[i++];
      const r = product();
      v = r === undefined ? undefined : op === "+" ? v + r : v > r ? v - r : 0n;
    }
    return v;
  };
  const v = sum();
  return i === text.length ? v : undefined;
}

/**
 * log2 of a closed natural-number expression, approximately (Infinity when even that overflows);
 * undefined when the text is not one. For sizes far beyond what can be computed:
 * 2025 ^ (2024 ^ 2024) has a log2 of about 2.4 × 10^6690.
 */
export function natExprLog2(src: string): number | undefined {
  const text = src.replace(/\(\s*(\d+)\s*:\s*(?:ℕ|Nat|ℤ|Int)\s*\)/g, "$1").replace(/\s+/g, "");
  if (!/^[\d+\-*^()]+$/.test(text)) return undefined;
  let i = 0;
  const atom = (): number | undefined => {
    if (text[i] === "(") {
      i++;
      const v = sum();
      if (text[i] !== ")") return undefined;
      i++;
      return v;
    }
    const m = /^\d+/.exec(text.slice(i));
    if (!m) return undefined;
    i += m[0].length;
    const d = m[0].replace(/^0+(?=\d)/, "");
    // log2 of the literal, also for literals longer than a double.
    return d === "0" ? -Infinity : Math.log2(Number(d.slice(0, 15))) + Math.max(0, d.length - 15) * Math.log2(10);
  };
  const power = (): number | undefined => {
    const b = atom();
    if (b === undefined) return undefined;
    if (text[i] !== "^") return b;
    i++;
    const e = power();
    if (e === undefined) return undefined;
    if (b <= 0) return b === 0 ? 0 : -Infinity; // 1 ^ e = 1, 0 ^ e = 0
    return b * 2 ** e; // log2(b^e) = e · log2 b, e = 2^(log2 e)
  };
  const product = (): number | undefined => {
    let v = power();
    while (v !== undefined && text[i] === "*") {
      i++;
      const r = power();
      v = r === undefined ? undefined : v + r;
    }
    return v;
  };
  const sum = (): number | undefined => {
    let v = product();
    while (v !== undefined && (text[i] === "+" || text[i] === "-")) {
      i++;
      const r = product();
      v = r === undefined ? undefined : Math.max(v, r) + (r === v ? 1 : 0);
    }
    return v;
  };
  const v = sum();
  return i === text.length ? v : undefined;
}

/** Lean refuses `Nat.pow` with an exponent above 2^24 ("Nat.pow exponent is too big"). */
export const LEAN_POW_EXPONENT_LOG2 = 24;

/**
 * The first power in a Lean statement whose exponent is beyond what Lean can compute
 * (`2025 ^ (2024 ^ 2024)`): its text and the exponent's approximate number of decimal digits.
 */
export function hugePower(statement: string): { text: string; exponentDigits: number } | undefined {
  for (const m of statement.matchAll(/(\d+|\))\s*\^\s*/g)) {
    const from = m.index! + m[0].length;
    let exponent: string | undefined;
    if (statement[from] === "(") {
      let depth = 0;
      for (let j = from; j < statement.length; j++) {
        if (statement[j] === "(") depth++;
        else if (statement[j] === ")" && --depth === 0) {
          exponent = statement.slice(from, j + 1);
          break;
        }
      }
    } else {
      exponent = /^\d+(?:\s*\^\s*(?:\d+|\([^()]*\)))*/.exec(statement.slice(from))?.[0];
    }
    if (!exponent) continue;
    const log2 = natExprLog2(exponent);
    if (log2 === undefined || !(log2 > LEAN_POW_EXPONENT_LOG2)) continue;
    // The base as written right before `^` (a number, or a parenthesised group).
    let start = m.index!;
    if (m[1] === ")") {
      let depth = 0;
      for (let j = m.index!; j >= 0; j--) {
        if (statement[j] === ")") depth++;
        else if (statement[j] === "(" && --depth === 0) {
          start = j;
          break;
        }
      }
    }
    return { text: `${statement.slice(start, m.index! + m[1].length)} ^ ${exponent.replace(/\s+/g, " ")}`, exponentDigits: Number.isFinite(log2) ? Math.floor(log2 * Math.log10(2)) + 1 : Infinity };
  }
  return undefined;
}
