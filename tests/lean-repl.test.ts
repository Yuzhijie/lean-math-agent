import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { ReplPool, ReplWorker, ReplError, type ReplConfig } from "@/lib/lean/repl";

const FAKE = path.resolve(__dirname, "fixtures/fake-repl.mjs");

function fakeConfig(overrides: Partial<ReplConfig> = {}): ReplConfig {
  return {
    cwd: process.cwd(),
    binPath: FAKE,
    launcher: { command: process.execPath, args: [FAKE] },
    workers: 1,
    maxUsesPerWorker: 100,
    headerTimeoutMs: 5_000,
    commandTimeoutMs: 2_000,
    idleTimeoutMs: 0,
    ...overrides,
  };
}

let pools: ReplPool[] = [];
function makePool(overrides?: Partial<ReplConfig>): ReplPool {
  const p = new ReplPool(fakeConfig(overrides));
  pools.push(p);
  return p;
}

afterEach(() => {
  for (const p of pools) p.shutdown();
  pools = [];
});

describe("ReplWorker protocol", () => {
  it("imports a header once and reuses its env id", async () => {
    const pool = makePool();
    const envs = await pool.withWorker(async (w) => {
      const a = await w.headerEnv(["Mathlib"]);
      const b = await w.headerEnv(["Mathlib"]);
      const c = await w.headerEnv(["Mathlib", "Aesop"]);
      return [a, b, c];
    });
    expect(envs[0]).toBe(envs[1]);
    expect(envs[2]).not.toBe(envs[0]);
  });

  it("returns messages and sorries for a command", async () => {
    const pool = makePool();
    const resp = await pool.withWorker(async (w) => {
      const env = await w.headerEnv([]);
      return w.command({ cmd: "theorem t (n : Nat) : n + 0 = n := by\n  sorry\n#print axioms t", env }, 2_000);
    });
    expect(resp.sorries).toHaveLength(1);
    expect(resp.sorries[0].goal).toContain("⊢ n + 0 = n");
    const info = resp.messages.find((m) => m.severity === "info");
    expect(info?.data).toBe("'t' depends on axioms: [sorryAx]");
  });

  it("reassembles a response that arrives in many small chunks", async () => {
    const pool = makePool();
    const resp = await pool.withWorker(async (w) => {
      const env = await w.headerEnv([]);
      return w.command({ cmd: "theorem t : True := trivial\n#check @t\n-- PRETTY", env }, 3_000);
    });
    expect(resp.messages[0].data).toBe("t : ∀ (n : Nat), n + 0 = n");
  });

  it("serialises commands on one worker", async () => {
    const pool = makePool();
    const results = await pool.withWorker(async (w) => {
      const env = await w.headerEnv([]);
      return Promise.all([
        w.command({ cmd: "theorem a : True := trivial\n#check @a", env }, 2_000),
        w.command({ cmd: "theorem b : True := trivial\n#check @b", env }, 2_000),
        w.command({ cmd: "theorem c : True := trivial\n#check @c", env }, 2_000),
      ]);
    });
    expect(results.map((r) => r.messages[0].data.split(" ")[0])).toEqual(["a", "b", "c"]);
    expect(new Set(results.map((r) => r.env)).size).toBe(3);
  });

  it("times out and kills the worker, then the pool recovers with a new one", async () => {
    const pool = makePool({ commandTimeoutMs: 300 });
    await expect(
      pool.withWorker(async (w) => {
        const env = await w.headerEnv([]);
        return w.command({ cmd: "SLEEP", env }, 300);
      }),
    ).rejects.toMatchObject({ kind: "timeout" });
    // A fresh worker is started transparently.
    const resp = await pool.withWorker(async (w) => {
      const env = await w.headerEnv([]);
      return w.command({ cmd: "theorem t : True := trivial", env }, 2_000);
    });
    expect(resp.env).toBeGreaterThanOrEqual(0);
    expect(pool.size).toBe(1);
  });

  it("reports a crash as ReplError(crashed) and replaces the worker", async () => {
    const pool = makePool();
    await expect(
      pool.withWorker(async (w) => {
        const env = await w.headerEnv([]);
        return w.command({ cmd: "BOOM", env }, 2_000);
      }),
    ).rejects.toMatchObject({ kind: "crashed" });
    const resp = await pool.withWorker(async (w) => w.command({ cmd: "theorem t : True := trivial" }, 2_000));
    expect(resp.env).toBe(0); // brand-new fake process
  });

  it("classifies the REPL's own error objects as protocol errors", async () => {
    const pool = makePool();
    await expect(
      pool.withWorker(async (w) => w.command({ cmd: "theorem t : True := trivial", env: 99 }, 2_000)),
    ).rejects.toSatisfy((e: unknown) => e instanceof ReplError && e.kind === "protocol");
  });

  it("recycles a worker after maxUsesPerWorker commands", async () => {
    const pool = makePool({ maxUsesPerWorker: 2 });
    const firstEnvs = await pool.withWorker(async (w) => {
      const e1 = await w.command({ cmd: "theorem a : True := trivial" }, 2_000);
      const e2 = await w.command({ cmd: "theorem b : True := trivial" }, 2_000);
      return [e1.env, e2.env];
    });
    expect(firstEnvs).toEqual([0, 1]);
    // Next acquisition sees uses >= 2 → new process, env counter restarts.
    const resp = await pool.withWorker(async (w) => w.command({ cmd: "theorem c : True := trivial" }, 2_000));
    expect(resp.env).toBe(0);
  });

  it("fails with ReplError(unavailable) when the binary is missing", async () => {
    const pool = makePool({ binPath: "/nonexistent/repl" });
    await expect(pool.withWorker(async (w) => w.command({ cmd: "x" }, 1_000))).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("runs commands on multiple workers concurrently", async () => {
    const pool = makePool({ workers: 2 });
    const started: number[] = [];
    const tasks = [0, 1, 2].map((i) =>
      pool.withWorker(async (w) => {
        started.push(i);
        const env = await w.headerEnv([]);
        return w.command({ cmd: `theorem t${i} : True := trivial`, env }, 2_000);
      }),
    );
    const results = await Promise.all(tasks);
    expect(results).toHaveLength(3);
    expect(pool.size).toBe(2);
  });
});

describe("ReplWorker direct", () => {
  it("start() rejects for a missing binary", async () => {
    const w = new ReplWorker(fakeConfig({ binPath: "/nonexistent/repl" }), 1);
    await expect(w.start()).rejects.toMatchObject({ kind: "unavailable" });
  });
});
