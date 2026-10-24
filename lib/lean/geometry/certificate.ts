/**
 * Polynomial certificates from scripts/poly_certificate.py (SymPy): the compute server's
 * POST /certificate when COMPUTE_ENGINE_URL is set (the Docker setup), else the script run with
 * GEOMETRY_PYTHON (default python3). Nothing here is trusted: the proof built from the answer is
 * checked by Lean.
 *
 * The request carries only what the problem uses: variables renumbered to those that occur,
 * hypotheses and multipliers under plain aliases (h0, m0 — Lean names such as `h₁` or `hAB'` are
 * not plain identifiers), oversized polynomials left out. The answer is mapped back.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { MAX_DEGREE, MAX_TERMS, Poly } from "./poly";

export interface CertificateRequest {
  vars: string[];
  hyps: { name: string; poly: Poly }[];
  goal: Poly;
  multipliers: { name: string; poly: Poly }[];
  timeoutSec?: number;
}

/** One factor of the multiplier: an irreducible factor of the candidate `source` (candidate = factor · cofactor). */
export interface MultiplierFactor {
  source: string;
  factor: Poly;
  cofactor: Poly;
}

export type CertificateResult =
  | { ok: true; multiplier: MultiplierFactor[]; coefficients: Map<string, Poly> }
  | { ok: false; reason: string };

type Sparse = [string, Record<string, number>][];

const fits = (p: Poly) => p.terms.size <= MAX_TERMS && p.degree() <= MAX_DEGREE;

interface Prepared {
  body: string;
  /** compact index → original index */
  back: Map<number, number>;
  hypName: Map<string, string>;
  multName: Map<string, string>;
}

function prepare(req: CertificateRequest): Prepared {
  const hyps = req.hyps.filter((h) => fits(h.poly));
  const mults = req.multipliers.filter((m) => fits(m.poly));
  const used = new Set<number>();
  for (const p of [req.goal, ...hyps.map((h) => h.poly), ...mults.map((m) => m.poly)]) for (const v of p.vars()) used.add(v);
  const order = [...used].sort((a, b) => a - b);
  const to = new Map(order.map((v, i) => [v, i]));
  const back = new Map(order.map((v, i) => [i, v]));
  const hypName = new Map<string, string>();
  const multName = new Map<string, string>();
  const body = {
    vars: order.map((_, i) => `v${i}`),
    hyps: hyps.map((h, i) => {
      hypName.set(`h${i}`, h.name);
      return { name: `h${i}`, poly: h.poly.rename(to).toSparse() };
    }),
    goal: req.goal.rename(to).toSparse(),
    multipliers: mults.map((m, i) => {
      multName.set(`m${i}`, m.name);
      return { name: `m${i}`, poly: m.poly.rename(to).toSparse() };
    }),
    timeout: req.timeoutSec ?? 30,
  };
  return { body: JSON.stringify(body), back, hypName, multName };
}

function parseAnswer(raw: unknown, prep: Prepared): CertificateResult {
  const r = raw as { ok?: boolean; reason?: string; multiplier?: { source: string; factor: Sparse; cofactor: Sparse }[]; coefficients?: Record<string, Sparse> };
  if (!r || typeof r !== "object") return { ok: false, reason: "no answer" };
  if (!r.ok) return { ok: false, reason: r.reason ?? "no certificate" };
  const fromSparse = (sp: Sparse) => Poly.fromSparse(sp).rename(prep.back);
  const coefficients = new Map<string, Poly>();
  for (const [k, v] of Object.entries(r.coefficients ?? {})) {
    const name = prep.hypName.get(k);
    if (!name) return { ok: false, reason: `unknown hypothesis ${k} in the answer` };
    coefficients.set(name, fromSparse(v));
  }
  const multiplier: MultiplierFactor[] = [];
  for (const m of r.multiplier ?? []) {
    const source = prep.multName.get(m.source);
    if (!source) return { ok: false, reason: `unknown multiplier ${m.source} in the answer` };
    multiplier.push({ source, factor: fromSparse(m.factor), cofactor: fromSparse(m.cofactor) });
  }
  return { ok: true, multiplier, coefficients };
}

const MAX_OUTPUT = 8 * 1024 * 1024;

/** POST /certificate on the compute server, else the script; the parsed JSON answer (null on failure). */
async function transport(body: string, timeoutMs: number): Promise<unknown> {
  const url = process.env.COMPUTE_ENGINE_URL;
  if (url) {
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/certificate`, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return await res.json().catch(() => null);
      if (res.status === 408) return null;
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return null;
    }
  }
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v: unknown) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(v);
      }
    };
    const child = spawn(process.env.GEOMETRY_PYTHON ?? "python3", [path.join(process.cwd(), "scripts", "poly_certificate.py")], { stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    child.on("error", () => finish(null));
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.length > MAX_OUTPUT) {
        child.kill("SIGKILL");
        finish(null);
      }
    });
    child.on("close", () => {
      try {
        finish(JSON.parse(out));
      } catch {
        finish(null);
      }
    });
    child.stdin.end(body);
  });
}

function runScript(prep: Prepared, timeoutMs: number): Promise<CertificateResult> {
  const python = process.env.GEOMETRY_PYTHON ?? "python3";
  const script = path.join(process.cwd(), "scripts", "poly_certificate.py");
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    const finish = (r: CertificateResult) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(r);
      }
    };
    const child = spawn(python, [script], { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, reason: "the certificate search timed out" });
    }, timeoutMs);
    child.on("error", (e) => finish({ ok: false, reason: `cannot run ${python}: ${e.message}` }));
    // the child may exit without reading (no sympy): a write error must not become an uncaught exception
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.length > MAX_OUTPUT) {
        child.kill("SIGKILL");
        finish({ ok: false, reason: "the certificate is too large" });
      }
    });
    child.stderr.on("data", (d) => {
      if (err.length < 64 * 1024) err += d;
    });
    child.on("close", () => {
      try {
        finish(parseAnswer(JSON.parse(out), prep));
      } catch {
        finish({ ok: false, reason: (err.trim().split("\n").pop() ?? "").slice(0, 200) || "no answer from the certificate script (is sympy installed?)" });
      }
    });
    child.stdin.end(prep.body);
  });
}

export async function findCertificate(req: CertificateRequest): Promise<CertificateResult> {
  const prep = prepare(req);
  const timeoutMs = ((req.timeoutSec ?? 30) + 10) * 1000;
  const url = process.env.COMPUTE_ENGINE_URL;
  if (url) {
    let res: Response | undefined;
    try {
      res = await fetch(`${url.replace(/\/$/, "")}/certificate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: prep.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // a timeout is an answer; a refused connection means no server: run the script
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return { ok: false, reason: "the certificate search timed out" };
    }
    if (res) {
      if (res.ok) return parseAnswer(await res.json().catch(() => null), prep);
      if (res.status === 408) return { ok: false, reason: "the certificate search timed out" };
      // 404: an older server without /certificate; 413: too large for it — run the script
    }
  }
  return runScript(prep, timeoutMs);
}

// ── Numeric points (refutation) ───────────────────────────────────────────

export interface PointsRequest {
  /** Variable count of the problem's VarTable (v0…). */
  vars: number;
  fixed: Map<number, number>;
  equations: Poly[];
  inequalities: { poly: Poly; rel: ">" | ">=" | "!=" }[];
  timeoutSec?: number;
}

/** Points satisfying the polynomial system (proposals only: the caller checks them). */
export async function findPoints(req: PointsRequest): Promise<Map<number, number>[]> {
  const eqs = req.equations.filter(fits);
  const ineqs = req.inequalities.filter((q) => fits(q.poly));
  const used = new Set<number>(req.fixed.keys());
  for (const p of [...eqs, ...ineqs.map((q) => q.poly)]) for (const v of p.vars()) used.add(v);
  const order = [...used].sort((a, b) => a - b);
  if (!order.length || !eqs.length) return [];
  const to = new Map(order.map((v, i) => [v, i]));
  const body = JSON.stringify({
    mode: "points",
    vars: order.map((_, i) => `v${i}`),
    fixed: Object.fromEntries([...req.fixed].filter(([v]) => to.has(v)).map(([v, x]) => [`v${to.get(v)}`, String(x)])),
    equations: eqs.map((p) => p.rename(to).toSparse()),
    inequalities: ineqs.map((q) => ({ poly: q.poly.rename(to).toSparse(), rel: q.rel })),
    timeout: req.timeoutSec ?? 20,
  });
  const raw = await transport(body, ((req.timeoutSec ?? 20) + 10) * 1000);
  const r = raw as { ok?: boolean; points?: Record<string, string>[] } | null;
  if (!r?.ok || !Array.isArray(r.points)) return [];
  return r.points.map((pt) => new Map(Object.entries(pt).map(([k, v]) => [order[Number(k.slice(1))], Number(v)])));
}
