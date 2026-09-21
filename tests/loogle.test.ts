import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isLoogleEnabled,
  loogleHintsForUnknownIdentifiers,
  loogleSearch,
  unknownIdentifiers,
} from "@/lib/lean/loogle";

afterEach(() => {
  delete process.env.LOOGLE_URL;
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("loogle client", () => {
  it("is disabled without LOOGLE_URL and returns no hits", async () => {
    expect(isLoogleEnabled()).toBe(false);
    const f = vi.fn();
    expect(await loogleSearch("Nat.add_comm", { fetchImpl: f as unknown as typeof fetch })).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it("queries <url>/json?q= and maps hits", async () => {
    process.env.LOOGLE_URL = "https://loogle.example/";
    const f = vi.fn(async (_url: string) =>
      jsonResponse({
        hits: [
          { name: "Nat.add_comm", type: "∀ (n m : ℕ), n + m = m + n", module: "Init.Data.Nat.Basic", doc: "comm" },
          { name: "Nat.add_left_comm", type: "∀ (n m k : ℕ), n + (m + k) = m + (n + k)", module: "Init" },
          { name: "junk", type: 42 },
        ],
      }),
    );
    const hits = await loogleSearch("add_comm", { fetchImpl: f as unknown as typeof fetch, limit: 5 });
    expect(hits).toEqual([
      { name: "Nat.add_comm", type: "∀ (n m : ℕ), n + m = m + n", module: "Init.Data.Nat.Basic", doc: "comm" },
      { name: "Nat.add_left_comm", type: "∀ (n m k : ℕ), n + (m + k) = m + (n + k)", module: "Init", doc: undefined },
    ]);
    expect(String(f.mock.calls[0][0])).toBe("https://loogle.example/json?q=add_comm");
  });

  it("degrades to no hits on HTTP errors, Loogle errors and network failures", async () => {
    process.env.LOOGLE_URL = "https://loogle.example";
    const bad = vi.fn(async () => jsonResponse({ error: "parse error" }));
    expect(await loogleSearch("???", { fetchImpl: bad as unknown as typeof fetch })).toEqual([]);
    const http = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(await loogleSearch("x", { fetchImpl: http as unknown as typeof fetch })).toEqual([]);
    const net = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await loogleSearch("x", { fetchImpl: net as unknown as typeof fetch })).toEqual([]);
  });

  it("extracts unknown identifiers from Lean errors and formats hints", async () => {
    expect(unknownIdentifiers(["unknown identifier 'Nat.foo_bar'", "unknown constant 'Real.sqrt_four'", "unknown identifier 'Nat.foo_bar'"]))
      .toEqual(["Nat.foo_bar", "Real.sqrt_four"]);

    process.env.LOOGLE_URL = "https://loogle.example";
    const f = vi.fn(async (url: string) =>
      String(url).includes("foo_bar")
        ? jsonResponse({ hits: [{ name: "Nat.foo_baz", type: "∀ n : ℕ, n = n", module: "M" }] })
        : jsonResponse({ hits: [] }),
    );
    const text = await loogleHintsForUnknownIdentifiers(
      ["unknown identifier 'Nat.foo_bar'", "unknown identifier 'Real.sqrt_four'"],
      { fetchImpl: f as unknown as typeof fetch },
    );
    expect(text).toContain("`Nat.foo_bar` does not exist.");
    expect(text).toContain("- Nat.foo_baz : ∀ n : ℕ, n = n");
    expect(text).not.toContain("sqrt_four` does not exist");
    // Queries use the last name component.
    expect(String(f.mock.calls[0][0])).toContain("q=foo_bar");
  });
});
