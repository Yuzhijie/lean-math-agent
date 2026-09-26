import { describe, expect, it } from "vitest";
import { matchLocale, parseAcceptLanguage, prefFromCookie } from "@/lib/i18n/config";
import { buildFigure } from "@/lib/figure/check";
import { renderFigureSvg } from "@/lib/figure/render";
import { figureSpecSchema } from "@/lib/figure/spec";

describe("locale detection", () => {
  it("parses Accept-Language by quality", () => {
    expect(parseAcceptLanguage("en-AU,en;q=0.9,zh-CN;q=0.8")).toEqual(["en-AU", "en", "zh-CN"]);
    expect(parseAcceptLanguage("fr;q=0.5, zh-TW;q=0.9, *;q=0.1")).toEqual(["zh-TW", "fr"]);
    expect(parseAcceptLanguage(null)).toEqual([]);
  });

  it("maps system languages to a supported locale", () => {
    expect(matchLocale(["zh-Hans-CN"])).toBe("zh-CN");
    expect(matchLocale(["zh-TW", "en"])).toBe("zh-CN");
    expect(matchLocale(["en-AU", "zh-CN"])).toBe("en-US");
    expect(matchLocale(["fr-FR", "zh-CN"])).toBe("zh-CN"); // first supported language wins
    expect(matchLocale(["ja-JP"])).toBe("en-US"); // neither → English
    expect(matchLocale([])).toBe("zh-CN"); // unknown → default
  });

  it("treats anything but a supported locale in the cookie as follow-system", () => {
    expect(prefFromCookie("en-US")).toBe("en-US");
    expect(prefFromCookie("zh-CN")).toBe("zh-CN");
    expect(prefFromCookie("")).toBe("system");
    expect(prefFromCookie("de-DE")).toBe("system");
    expect(prefFromCookie(undefined)).toBe("system");
  });
});

describe("diagram labels follow the locale", () => {
  const fig = buildFigure(
    figureSpecSchema.parse({ needed: true, logic: { type: "tree", levels: [{ label: "Top", options: ["red", "blue"] }, { label: "Pants", options: ["black", "white"] }] } }),
  );
  it("renders Chinese by default and English on request", () => {
    expect(renderFigureSvg(fig)).toContain("共 4 种");
    const en = renderFigureSvg(fig, { locale: "en-US" });
    expect(en).toContain("4 in total");
    expect(en).not.toMatch(/[一-鿿]/);
    // The next Chinese render is not affected by the previous English one.
    expect(renderFigureSvg(fig)).toContain("共 4 种");
  });
});
