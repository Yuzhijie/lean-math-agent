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
