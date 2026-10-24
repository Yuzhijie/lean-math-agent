/**
 * Polynomial certificates from scripts/poly_certificate.py (SymPy): the compute server's
 * POST /certificate when COMPUTE_ENGINE_URL is set (the Docker setup), else the script run with
 * GEOMETRY_PYTHON (default python3). Nothing here is trusted: the proof built from the answer is
 * checked by Lean.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { Poly } from "./poly";

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

function payload(req: CertificateRequest) {
  return {
    vars: req.vars,
    hyps: req.hyps.map((h) => ({ name: h.name, poly: h.poly.toSparse() })),
    goal: req.goal.toSparse(),
    multipliers: req.multipliers.map((m) => ({ name: m.name, poly: m.poly.toSparse() })),
    timeout: req.timeoutSec ?? 30,
  };
}

function parseAnswer(raw: unknown): CertificateResult {
  type Sparse = [string, Record<string, number>][];
  const r = raw as { ok?: boolean; reason?: string; multiplier?: { source: string; factor: Sparse; cofactor: Sparse }[]; coefficients?: Record<string, Sparse> };
  if (!r || typeof r !== "object") return { ok: false, reason: "no answer" };
  if (!r.ok) return { ok: false, reason: r.reason ?? "no certificate" };
  const coefficients = new Map<string, Poly>();
  for (const [k, v] of Object.entries(r.coefficients ?? {})) coefficients.set(k, Poly.fromSparse(v));
  const multiplier = (r.multiplier ?? []).map((m) => ({ source: m.source, factor: Poly.fromSparse(m.factor), cofactor: Poly.fromSparse(m.cofactor) }));
  return { ok: true, multiplier, coefficients };
}

function runScript(body: string, timeoutMs: number): Promise<CertificateResult> {
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
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", () => {
      try {
        finish(parseAnswer(JSON.parse(out)));
      } catch {
        finish({ ok: false, reason: (err.trim().split("\n").pop() ?? "").slice(0, 200) || "no answer from the certificate script (is sympy installed?)" });
      }
    });
    child.stdin.end(body);
  });
}

export async function findCertificate(req: CertificateRequest): Promise<CertificateResult> {
  const body = JSON.stringify(payload(req));
  const timeoutMs = ((req.timeoutSec ?? 30) + 10) * 1000;
  const url = process.env.COMPUTE_ENGINE_URL;
  if (url) {
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/certificate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return parseAnswer(await res.json());
    } catch {
      // server down: fall back to the script
    }
  }
  return runScript(body, timeoutMs);
}
