import { describe, expect, it } from "vitest";
import { extractJson, fixLatexEscapes } from "@/lib/llm/client";

describe("LaTeX in model JSON", () => {
  it("keeps LaTeX written with one backslash", () => {
    const raw = String.raw`{"text": "In $\triangle ABC$, $\angle A = 60^\circ$, $\frac{1}{2} \times 3 \neq \beta$, $\sqrt{2}$"}`;
    expect((extractJson(raw) as { text: string }).text).toBe(
      String.raw`In $\triangle ABC$, $\angle A = 60^\circ$, $\frac{1}{2} \times 3 \neq \beta$, $\sqrt{2}$`,
    );
  });

  it("leaves real escapes alone", () => {
    const raw = String.raw`{"a": "line\nnext\tcol \"q\" \\frac é \nThe end"}`;
    expect(fixLatexEscapes(raw)).toBe(raw);
    expect((extractJson(raw) as { a: string }).a).toBe('line\nnext\tcol "q" \\frac é \nThe end');
  });

  it("does nothing without backslashes", () => {
    expect(fixLatexEscapes('{"a": 1}')).toBe('{"a": 1}');
  });
});
