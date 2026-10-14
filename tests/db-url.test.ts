import { describe, expect, it } from "vitest";
import { sqliteUrl } from "@/lib/db-url";

describe("sqliteUrl (Prisma 7 driver adapter)", () => {
  it("keeps Prisma 5's location for relative file URLs (resolved against prisma/)", () => {
    expect(sqliteUrl(undefined, "/app")).toBe("file:/app/prisma/.data/prod.db");
    expect(sqliteUrl("file:.data/prod.db", "/app")).toBe("file:/app/prisma/.data/prod.db");
    expect(sqliteUrl("file:./dev.db", "/app")).toBe("file:/app/prisma/dev.db");
  });
  it("leaves absolute paths, memory databases and other URLs alone", () => {
    expect(sqliteUrl("file:/var/db/app.db", "/app")).toBe("file:/var/db/app.db");
    expect(sqliteUrl("file::memory:", "/app")).toBe("file::memory:");
    expect(sqliteUrl("postgresql://u@h/db", "/app")).toBe("postgresql://u@h/db");
  });
});
