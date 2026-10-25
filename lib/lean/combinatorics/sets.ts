/**
 * Finset expressions as Lean prints them — names, `∪`, `∩`, `\`, `ᶜ`, `Finset.univ`, `∅`,
 * parentheses — read as Boolean formulas over membership in the named sets (Lean precedences:
 * `∪` 65 left, `∩` and `\` 70 left, `ᶜ` postfix).
 */
export type SetExpr =
  | { k: "var"; name: string }
  | { k: "univ" }
  | { k: "empty" }
  | { k: "compl"; a: SetExpr }
  | { k: "bin"; op: "∪" | "∩" | "\\"; a: SetExpr; b: SetExpr };

export function parseSetExpr(src: string): SetExpr | undefined {
  const toks = src.match(/Finset\.univ|∅|[A-Za-z_][\w'₀-₉]*|[∪∩\\ᶜ()]|\S/g) ?? [];
  let i = 0;
  const peek = () => toks[i];
  function atom(): SetExpr | undefined {
    const t = toks[i++];
    let e: SetExpr | undefined;
    if (t === "(") {
      e = union();
      if (toks[i++] !== ")") return undefined;
    } else if (t === "Finset.univ") e = { k: "univ" };
    else if (t === "∅") e = { k: "empty" };
    else if (t && /^[A-Za-z_]/.test(t)) e = { k: "var", name: t };
    else return undefined;
    while (e && peek() === "ᶜ") {
      i++;
      e = { k: "compl", a: e };
    }
    return e;
  }
  function inter(): SetExpr | undefined {
    let a = atom();
    while (a && (peek() === "∩" || peek() === "\\")) {
      const op = toks[i++] as "∩" | "\\";
      const b = atom();
      if (!b) return undefined;
      a = { k: "bin", op, a, b };
    }
    return a;
  }
  function union(): SetExpr | undefined {
    let a = inter();
    while (a && peek() === "∪") {
      i++;
      const b = inter();
      if (!b) return undefined;
      a = { k: "bin", op: "∪", a, b };
    }
    return a;
  }
  const e = union();
  return e && i === toks.length ? e : undefined;
}

export function setVars(e: SetExpr, out = new Set<string>()): Set<string> {
  if (e.k === "var") out.add(e.name);
  else if (e.k === "compl") setVars(e.a, out);
  else if (e.k === "bin") {
    setVars(e.a, out);
    setVars(e.b, out);
  }
  return out;
}

/** Whether `e` mentions the universe (complement or univ): then the region outside every set counts. */
export function usesUniverse(e: SetExpr): boolean {
  if (e.k === "univ" || e.k === "compl") return true;
  if (e.k === "bin") return usesUniverse(e.a) || usesUniverse(e.b);
  return false;
}

/** Membership of an element whose memberships in the named sets are `inSet`. */
export function evalSet(e: SetExpr, inSet: (name: string) => boolean): boolean {
  switch (e.k) {
    case "var":
      return inSet(e.name);
    case "univ":
      return true;
    case "empty":
      return false;
    case "compl":
      return !evalSet(e.a, inSet);
    case "bin": {
      const a = evalSet(e.a, inSet);
      const b = evalSet(e.b, inSet);
      return e.op === "∪" ? a || b : e.op === "∩" ? a && b : a && !b;
    }
  }
}
