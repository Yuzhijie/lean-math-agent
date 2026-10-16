/**
 * Exact answers for "smallest positive n with a^n ≡ 1 (mod m), b^n ≡ 1 (mod k), …" questions,
 * computed by the program instead of trusted to a model: n works exactly when every
 * multiplicative order divides it, so the smallest n is the lcm of the orders.
 *
 * A model once answered 1814400 for 2^n ≡ 1 (mod 3^5·5^3), 3^n ≡ 1 (mod 2^8·7^2); the orders are
 * 162, 100, 64, 42 and the answer is lcm = 907200.
 */
import { evalNatExpr } from "./nat-expr";

export interface Congruence {
  base: bigint;
  /** Right-hand side (reduced mod modulus). */
  rhs: bigint;
  modulus: bigint;
  /** As written, for messages. */
  text: string;
}

export interface OrderCheck {
  /** Smallest positive n, or undefined when no n works. */
  answer?: bigint;
  congruences: Congruence[];
  /** Order of each base modulo its modulus (same order as congruences). */
  orders: bigint[];
  /** Why there is no solution (base not coprime to the modulus). */
  impossible?: string;
}

/** A modulus or base written in LaTeX / plain text (`3^5\cdot 5^3`, `2^{8}×7^2`) → value. */
export function latexNat(src: string): bigint | undefined {
  const plain = src
    .replace(/\\(?:cdot|times)/g, "*")
    .replace(/[×·⋅]/g, "*")
    .replace(/\\left|\\right|\\,|\\;|\\!/g, "")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")");
  return evalNatExpr(plain);
}

const VAR = "([a-zA-Z])";
// a^n ≡ r (mod m) in LaTeX or plain text; the modulus as \pmod{…}, \pmod m, (mod …), \bmod …
const CONGRUENCE = new RegExp(
  String.raw`(\d+)\s*\^\s*\{?\s*` + VAR + String.raw`\s*\}?\s*(?:\\equiv|≡)\s*(-?\d+)\s*` +
    String.raw`(?:\\pmod\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}|\\pmod\s+([\d^{}\\a-z* ]+?)(?=[$,，;；。]|\\qquad|\\quad|$)|\(\s*(?:\\bmod|\\mod|mod)\s*([^()]*(?:\([^()]*\)[^()]*)*)\))`,
  "g",
);

/** The congruences a^x ≡ r (mod m) in the text, all in the same unknown; undefined when there are none or the unknowns differ. */
export function readCongruences(text: string): { variable: string; congruences: Congruence[] } | undefined {
  const out: Congruence[] = [];
  let variable: string | undefined;
  for (const m of text.matchAll(CONGRUENCE)) {
    const base = BigInt(m[1]);
    const v = m[2];
    const modulus = latexNat((m[4] ?? m[5] ?? m[6] ?? "").trim());
    if (modulus === undefined || modulus < 1n) return undefined;
    if (variable !== undefined && v !== variable) return undefined;
    variable = v;
    const r = ((BigInt(m[3]) % modulus) + modulus) % modulus;
    out.push({ base, rhs: r, modulus, text: m[0].trim() });
  }
  return out.length && variable ? { variable, congruences: out } : undefined;
}

/** Whether the problem asks for the smallest positive value of the unknown. */
export function asksSmallestPositive(text: string): boolean {
  return /最小(?:的)?正整数|最小正整数|smallest positive|least positive|minimal positive/i.test(text);
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a < 0n ? -a : a;
}
const lcm = (a: bigint, b: bigint) => (a / gcd(a, b)) * b;

function powmod(b: bigint, e: bigint, m: bigint): bigint {
  if (m === 1n) return 0n;
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

/** Prime factorisation by trial division (moduli in these questions are small); undefined above 10^14. */
function factor(n: bigint): Map<bigint, number> | undefined {
  if (n > 10n ** 14n) return undefined;
  const f = new Map<bigint, number>();
  for (let p = 2n; p * p <= n; p += p === 2n ? 1n : 2n) {
    while (n % p === 0n) {
      f.set(p, (f.get(p) ?? 0) + 1);
      n /= p;
    }
  }
  if (n > 1n) f.set(n, (f.get(n) ?? 0) + 1);
  return f;
}

/** Carmichael λ(m): every unit's order divides it. */
function carmichael(f: Map<bigint, number>): bigint {
  let l = 1n;
  for (const [p, k] of f) {
    let v: bigint;
    if (p === 2n) v = k === 1 ? 1n : k === 2 ? 2n : 2n ** BigInt(k - 2);
    else v = (p - 1n) * p ** BigInt(k - 1);
    l = lcm(l, v);
  }
  return l;
}

/** Multiplicative order of a modulo m (gcd(a, m) = 1). */
export function multiplicativeOrder(a: bigint, m: bigint): bigint | undefined {
  if (m === 1n) return 1n;
  if (gcd(a, m) !== 1n) return undefined;
  const f = factor(m);
  if (!f) return undefined;
  let order = carmichael(f);
  const lf = factor(order);
  if (!lf) return undefined;
  for (const [p] of lf) {
    while (order % p === 0n && powmod(a, order / p, m) === 1n) order /= p;
  }
  return order;
}

/**
 * The smallest positive n for a problem that asks for it and whose conditions are all
 * a^n ≡ 1 (mod m); undefined when the problem is not of that kind (other right-hand sides,
 * other conditions the program does not read, too-large moduli).
 */
export function orderCheck(problemText: string): OrderCheck | undefined {
  if (!asksSmallestPositive(problemText)) return undefined;
  const read = readCongruences(problemText);
  if (!read) return undefined;
  const { congruences } = read;
  if (congruences.some((c) => c.rhs !== 1n % c.modulus)) return undefined;
  const orders: bigint[] = [];
  for (const c of congruences) {
    if (gcd(c.base, c.modulus) !== 1n && c.modulus !== 1n) {
      return { congruences, orders, impossible: `gcd(${c.base}, ${c.modulus}) ≠ 1` };
    }
    const o = multiplicativeOrder(c.base, c.modulus);
    if (o === undefined) return undefined;
    orders.push(o);
  }
  return { answer: orders.reduce(lcm, 1n), congruences, orders };
}
