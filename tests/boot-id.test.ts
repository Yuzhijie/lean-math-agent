import { describe, expect, it } from "vitest";
import { bootId } from "@/lib/boot";
import { GET } from "@/app/api/boot/route";

describe("server run id", () => {
  it("is the same for the whole run (also across a reload of the module)", async () => {
    const a = bootId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(bootId()).toBe(a);
    expect(await (await GET()).json()).toEqual({ boot: a });
  });
});
