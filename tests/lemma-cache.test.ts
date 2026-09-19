import { describe, it, expect } from "vitest";
import { LemmaCache } from "@/lib/lean/lemma-cache";

describe("LemmaCache", () => {
  it("initializes with built-in common lemmas", async () => {
    const cache = new LemmaCache();
    await cache.initialize();
    expect(cache.size).toBeGreaterThan(0);
  });

  it("retrieves lemma by exact name", async () => {
    const cache = new LemmaCache();
    await cache.initialize();
    const lemma = cache.get("Nat.add_comm");
    expect(lemma).toBeTruthy();
    expect(lemma?.name).toBe("Nat.add_comm");
    expect(lemma?.type_signature).toContain("n + m = m + n");
  });

  it("returns undefined for unknown lemma", async () => {
    const cache = new LemmaCache();
    await cache.initialize();
    expect(cache.get("Nonexistent.lemma")).toBeUndefined();
  });

  it("searches by name substring", async () => {
    const cache = new LemmaCache();
    await cache.initialize();
    const results = cache.searchByName("add_comm");
    expect(results.length).toBeGreaterThanOrEqual(2); // Nat and Int versions
  });

  it("searches by type signature", async () => {
    const cache = new LemmaCache();
    await cache.initialize();
    const results = cache.searchBySignature("n + m = m + n");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("searches by tag", async () => {
    const cache = new LemmaCache();
    await cache.initialize();
    const results = cache.searchByTag("commutativity");
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("lists available tags", async () => {
    const cache = new LemmaCache();
    await cache.initialize();
    const tags = cache.getTags();
    expect(tags).toContain("arithmetic");
    expect(tags).toContain("logic");
  });
});
