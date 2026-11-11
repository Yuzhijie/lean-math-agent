/**
 * `npm run e2e` — end-to-end evaluation on the held-out problem set (bench/heldout.json).
 *
 * Every problem goes through the running app exactly as a user's would: the problem text is
 * posted to /api/solve (with the Lean step), and where a solve leaves the formal proof to be
 * started by hand (optimization / find-all problems) /api/lean-attempt is called as the Lean tab
 * does. The run records, per problem, whether the answer was right, whether a Lean statement was
 * accepted and whether it was proved — and what it cost. Results: bench/results/e2e-<time>.jsonl
 * (one line per problem, written as it finishes) and the report bench/E2E.md.
 *
 * The app must be running (`npm run dev`); this script calls no model itself, the app does — a
 * full run spends real LLM money, so start with a sample:
 *
 *   npm run e2e -- --sample 24 --max-cost 5
 *   npm run e2e -- --split dev                 # the part that may be inspected
 *   npm run e2e                                # everything (120 problems)
 *
 *   --base url          the app (default http://localhost:3000)
 *   --set file          the problem set (default bench/heldout.json)
 *   --split dev|test|all (default all)   --topic a,b   --ids a,b   --sample n   --limit n
 *   --concurrency n     problems in flight (default 1, as one user works; more only when the app has
 *                       as many Lean workers — LEAN_REPL_WORKERS — and a prover that serves as many
 *                       calls at once: otherwise problems fail waiting for each other, and the
 *                       run measures the queue)
 *   --max-cost usd      start no new problem once this much is spent (default 20; 0 = no cap)
 *   --timeout-min n     give up on one request after this long (default 60)
 *   --solve-only        one click only: do not start the Lean step by hand
 *   --resume file       continue an interrupted run: problems it finished are skipped
 *   --keep-sessions     leave the solved sessions in the app's history (default: deleted)
 *   --no-retry          do not run problems that ended in an error a second time
 *   --no-report         do not rewrite bench/E2E.md
 *   --cookie "k=v"      session cookie, when the app requires sign-in
 *   --list              print what would run, and stop
 *
 * Runs are marked with the header x-eval-run: the app then leaves its proof memory and learned
 * rules untouched, so a second run is not helped by the first.
 */
import { execSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { loadHeldout, selectProblems, type HeldoutProblem } from "../lib/e2e/heldout";
import { needsLeanAttempt, parseRun, rowOf, solved, stopOf, type Capture, type EvalRow, type RunFile, type RunMeta } from "../lib/e2e/outcome";
import { e2eReport } from "../lib/e2e/report";
import { EVAL_HEADER } from "../lib/eval-mode";

function argIn(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const arg = (name: string) => argIn(process.argv, name);
const flag = (name: string) => process.argv.includes(`--${name}`);
/** What selects the problems of a run. */
const SELECTORS = ["split", "topic", "ids", "sample", "limit"];

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

/** One request without the 5-minute header timeout of fetch: a solve answers only when it is done. */
export function call(method: string, url: string, opts: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
    const req = (u.protocol === "https:" ? https : http).request(
      u,
      { method, headers: { Accept: "application/json", ...(data ? { "Content-Type": "application/json", "Content-Length": String(data.length) } : {}), ...opts.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: Record<string, unknown>;
          try {
            const j = JSON.parse(text) as unknown;
            body = j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : { value: j };
          } catch {
            body = { error: text.slice(0, 300) || `HTTP ${res.statusCode}` };
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (opts.timeoutMs) req.setTimeout(opts.timeoutMs, () => req.destroy(new Error(`no answer after ${Math.round(opts.timeoutMs! / 60000)} min`)));
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RunnerOptions {
  base: string;
  lean: boolean;
  keepSessions: boolean;
  timeoutMs: number;
  headers: Record<string, string>;
  /** wait between tries when the app says "too many" (429) */
  busyWaitMs?: number;
}

/** One problem through the app, as a user would run it. */
export async function runProblem(p: HeldoutProblem, o: RunnerOptions): Promise<Capture> {
  const started = Date.now();
  const headers = { [EVAL_HEADER]: "1", ...o.headers };
  try {
    const drop = (id: unknown) => (typeof id === "string" ? call("DELETE", `${o.base}/api/session/${id}`, { headers, timeoutMs: 60_000 }).catch(() => undefined) : undefined);
    // 429 = rate limit, or every solve slot of this account taken: wait and ask again
    const patient = async (path: string, body: unknown): Promise<Reply> => {
      for (let attempt = 0; ; attempt++) {
        const r = await call("POST", `${o.base}${path}`, { body, headers, timeoutMs: o.timeoutMs });
        if (r.status !== 429 || attempt >= 30) return r;
        if (path === "/api/solve") await drop(r.body.session_id); // the refused solve had already made its session
        await sleep(o.busyWaitMs ?? 20_000);
      }
    };
    const solve = await patient("/api/solve", { problem_text: p.text, options: { lean_attempt: o.lean } });
    const sid = typeof solve.body.session_id === "string" ? solve.body.session_id : undefined;
    let lean: Reply | undefined;
    if (o.lean && sid && needsLeanAttempt(solve)) lean = await patient("/api/lean-attempt", { session_id: sid });
    const session = sid ? await call("GET", `${o.base}/api/session/${sid}`, { headers, timeoutMs: 60_000 }).catch(() => undefined) : undefined;
    if (!o.keepSessions) await drop(sid);
    return { solve, session: session?.status === 200 ? session.body : undefined, lean, ms: Date.now() - started };
  } catch (e) {
    return { ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  }
}

async function pool<T>(items: T[], n: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}

function gitCommit(): string | undefined {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

const usd = (x: number) => `$${x.toFixed(x < 1 ? 3 : 2)}`;
const mins = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 60_000).toFixed(1)} min`);

function line(r: EvalRow): string {
  const mark = r.status === "error" ? "!" : solved(r) ? "✓" : "✗";
  const what = r.status === "error" ? `error: ${r.error ?? ""}` : `${stopOf(r)}${r.proved && r.strategy ? ` (${r.strategy})` : ""}`;
  return `${mark} ${r.id.padEnd(6)} ${r.split.padEnd(4)} ${what}  ${mins(r.ms)}${r.cost_usd !== undefined ? `  ${usd(r.cost_usd)}` : ""}`;
}

/** Every run in the results directory (for the report). */
export function readRuns(dir: string): RunFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .flatMap((f) => {
      const r = parseRun(path.join(dir, f), readFileSync(path.join(dir, f), "utf8"));
      return r ? [r] : [];
    });
}

async function main() {
  const base = (arg("base") ?? process.env.E2E_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const setFile = arg("set") ?? path.join("bench", "heldout.json");
  const set = loadHeldout(setFile);
  const split = (arg("split") ?? "all") as "dev" | "test" | "all";
  if (!["dev", "test", "all"].includes(split)) {
    console.error(`--split must be dev, test or all (got ${split})`);
    process.exit(2);
  }
  // the interrupted run to continue, if any: without new selectors, the same problems as it had
  const resume = arg("resume");
  const prior = resume && existsSync(resume) ? parseRun(resume, readFileSync(resume, "utf8")) : undefined;
  if (resume && !prior) {
    console.error(`--resume: ${resume} is not a run file`);
    process.exit(2);
  }
  if (prior && prior.meta.set_hash !== set.hash) {
    console.error(`--resume: ${resume} was run on another version of the set (${prior.meta.set_hash}, now ${set.hash})`);
    process.exit(2);
  }
  const selArgv = prior && !SELECTORS.some((n) => arg(n) !== undefined) ? prior.meta.args : process.argv;
  const sel = (name: string) => argIn(selArgv, name);
  const list = (name: string) => sel(name)?.split(",").map((x) => x.trim()).filter(Boolean);
  const problems = selectProblems(set, {
    split: (sel("split") ?? split) as "dev" | "test" | "all",
    topics: list("topic"),
    ids: list("ids"),
    sample: sel("sample") !== undefined ? Number(sel("sample")) : undefined,
    limit: sel("limit") !== undefined ? Number(sel("limit")) : undefined,
  });
  const lean = prior ? prior.meta.lean : !flag("solve-only");
  const concurrency = Math.max(1, Math.floor(Number(arg("concurrency") ?? 1)) || 1);
  const maxCost = arg("max-cost") !== undefined ? Number(arg("max-cost")) : 20;
  const timeoutMs = Math.max(1, Number(arg("timeout-min") ?? 60)) * 60_000;
  const resultsDir = path.join("bench", "results");

  const count = (f: (p: HeldoutProblem) => string) => {
    const m = new Map<string, number>();
    for (const p of problems) m.set(f(p), (m.get(f(p)) ?? 0) + 1);
    return [...m.entries()].map(([k, v]) => `${k} ${v}`).join(", ");
  };
  console.log(`Set ${set.name} (${set.hash}): ${problems.length} of ${set.problems.length} problems — ${count((p) => p.split)}; ${count((p) => p.topic)}`);
  if (flag("list")) {
    for (const p of problems) console.log(`${p.id}  ${p.split}  ${p.topic}  ${p.kind}  L${p.level}${p.seen_family ? "  seen family" : ""}`);
    return;
  }
  if (!problems.length) {
    console.error("No problem selected.");
    process.exit(2);
  }

  const headers: Record<string, string> = arg("cookie") ? { Cookie: arg("cookie")! } : {};
  const health = await call("GET", `${base}/api/health`, { headers, timeoutMs: 60_000 }).catch((e: Error) => ({ status: 0, body: { error: e.message } }) as Reply);
  if (health.status === 0) {
    console.error(`The app does not answer at ${base} (${String(health.body.error)}). Start it with \`npm run dev\`, or pass --base.`);
    process.exit(2);
  }
  if (health.body.lean === false && lean) {
    console.error("The app reports that Lean is not available: the proofs cannot be measured. Fix the Lean sandbox, or run with --solve-only.");
    process.exit(2);
  }
  if (health.body.compute === false) console.warn("The compute server does not answer (`npm run compute`): computational problems will fall back to the model.");
  else if (health.status !== 200) console.warn(`Health check: HTTP ${health.status} ${JSON.stringify(health.body)} — continuing.`);

  // the results file: a new one, or the interrupted run's
  const done = new Map<string, EvalRow>();
  let file: string;
  if (prior) {
    file = resume!;
    for (const r of prior.rows) if (r.status === "done") done.set(r.id, r);
  } else {
    mkdirSync(resultsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    file = arg("out") ?? path.join(resultsDir, `e2e-${stamp}.jsonl`);
    const meta: RunMeta = { type: "run", at: new Date().toISOString(), set: set.name, set_hash: set.hash, set_size: set.problems.length, selected: problems.length, base, commit: gitCommit(), lean, args: process.argv.slice(2) };
    writeFileSync(file, JSON.stringify(meta) + "\n");
  }
  const todo = problems.filter((p) => !done.has(p.id));
  console.log(`${base} · ${concurrency} at a time · ${maxCost > 0 ? `stops starting new problems after ${usd(maxCost)}` : "no cost cap"} · ${lean ? "solve + Lean" : "solve only"} → ${file}`);
  if (done.size) console.log(`Resuming: ${done.size} already done, ${todo.length} to go.`);

  // A sleeping Mac stalls the app's model calls and Lean workers: stay awake while this run lives.
  if (process.platform === "darwin" && existsSync("/usr/bin/caffeinate")) {
    try {
      spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore", detached: true }).unref();
    } catch {
      // best effort
    }
  }
  const options: RunnerOptions = { base, lean, keepSessions: flag("keep-sessions"), timeoutMs, headers };
  const started = Date.now();
  const rows = new Map<string, EvalRow>(done);
  let spent = [...done.values()].reduce((a, r) => a + (r.cost_usd ?? 0), 0);
  let stopped: string | undefined;
  let finished = 0;
  let warnedNoCost = false;
  const runOne = async (p: HeldoutProblem, retried = false) => {
    if (maxCost > 0 && spent >= maxCost) {
      stopped ??= `stopped at the cost cap (${usd(maxCost)})`;
      return;
    }
    const row = { ...rowOf(p, await runProblem(p, options)), ...(retried ? { retried: true } : {}) };
    rows.set(p.id, row);
    appendFileSync(file, JSON.stringify(row) + "\n");
    spent += row.cost_usd ?? 0;
    if (row.status === "done" && row.cost_usd === undefined && !warnedNoCost) {
      warnedNoCost = true;
      console.warn("The app reports no cost (LLM_PRICES not set?): --max-cost cannot stop this run.");
    }
    if (!retried) finished++;
    console.log(`[${retried ? "retry" : `${finished}/${todo.length}`}] ${line(row)}${spent ? `  · total ${usd(spent)}` : ""}`);
  };
  await pool(todo, concurrency, (p) => runOne(p));
  const errors = todo.filter((p) => rows.get(p.id)?.status === "error");
  if (errors.length && !flag("no-retry") && !stopped) {
    console.log(`Running ${errors.length} problem(s) that ended in an error once more…`);
    await pool(errors, concurrency, (p) => runOne(p, true));
  }
  appendFileSync(file, JSON.stringify({ type: "end", at: new Date().toISOString(), wall_ms: Date.now() - started, ...(stopped ? { stopped } : {}) }) + "\n");

  const all = [...rows.values()];
  const ok = all.filter(solved).length;
  console.log(`\nSolved end to end: ${ok}/${all.length} (${all.length ? Math.round((ok / all.length) * 100) : 0}%)${spent ? ` · ${usd(spent)}` : ""} · ${mins(Date.now() - started)}`);
  const notRun = problems.length - all.length;
  if (notRun) console.log(`${notRun} problem(s) not run${stopped ? ` — ${stopped}` : ""}. Continue with: npm run e2e -- --resume ${file}${stopped ? " --max-cost <more>" : ""}`);
  if (!flag("no-report")) {
    const out = arg("report") ?? path.join("bench", "E2E.md");
    writeFileSync(out, e2eReport(readRuns(path.dirname(file)), { now: new Date() }));
    console.log(`Report: ${out}`);
  }
}

if (process.argv[1] && /e2e-eval\.[cm]?[tj]s$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
