import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allStarAngles, starAngles } from "@/lib/figure/star";
import { buildVisual, VISUAL_GUIDE, visualSpecSchema } from "@/lib/figure/visual";
import { angleCheck, generateFromTemplate } from "@/lib/bank/generate";
import { encodePng, loadSharp } from "@/lib/bank/import/images";
import { _closeAllBanks, addItems, createBank, saveAsset } from "@/lib/bank/store";
import { resetGlobalCache } from "@/lib/llm/cache";

// "This star has 6 lines of symmetry. It can be cut into 6 identical quadrilaterals like this one.
// The smallest angle is 38°. How many degrees is the largest angle?" — the star and its piece are
// computed from the number of points and the tip angle, so every angle agrees with the question.

const count = (svg: string, re: RegExp) => (svg.match(re) ?? []).length;

describe("stars cut into pieces", () => {
  it("computes the angles of the star and its pieces", () => {
    // 6 points, tip 76°: cut to the tips → 60°, 38°, 38° and the reflex 224° (the template: smallest 38°, largest 224°)
    expect(starAngles({ points: 6, tip_angle: 76, divide: "tips" }).piece.map((p) => p.angle)).toEqual([60, 38, 224, 38]);
    // cut to the inner corners → kites 60°, 112°, 76°, 112°
    expect(starAngles({ points: 6, tip_angle: 76, divide: "inner" }).piece.map((p) => p.angle)).toEqual([60, 112, 76, 112]);
    // a regular 5-point star: tip 36°, inner corner 252°
    expect(starAngles({ points: 5, tip_angle: 36, divide: "tips" }).starInner).toBe(252);
    expect(allStarAngles(visualSpecSchema.parse({ kind: "star", points: 6, tip_angle: 76, divide: "tips" }) as never)).toEqual(expect.arrayContaining([76, 38, 60, 224]));
  });

  it("draws the star, its division and one piece, and describes the angles", () => {
    const v = buildVisual(visualSpecSchema.parse({ kind: "star", points: 6, tip_angle: 76, divide: "tips", show_piece: true, piece_labels: { tip: "38°", inner: "?" }, symmetry_lines: true }));
    expect(v.source).toBe("program");
    expect(count(v.svg, /<polygon /g)).toBe(2); // the star and the piece
    expect(count(v.svg, /stroke-dasharray="5 4"/g)).toBe(6); // 6 lines of symmetry
    expect(v.svg).toContain(">38°<");
    expect(v.svg).toContain(">?<");
    expect(v.description).toContain("a 6-point star drawn to scale (all 6 tips the same; each tip angle 76°)");
    expect(v.description).toContain("6 identical concave quadrilaterals");
    expect(v.description).toContain("with angles 60° at the centre, 38° at a tip, 224° at the inner corner (reflex), 38° at a tip");
    expect(v.description).toContain('"?" at the inner corner (reflex)');
    expect(VISUAL_GUIDE).toContain('{"kind":"star","points"');
  });

  it("refuses a tip angle that gives no star, and a piece without a division", () => {
    expect(() => buildVisual(visualSpecSchema.parse({ kind: "star", points: 6, tip_angle: 130 }))).toThrow(/under 120°/);
    expect(() => buildVisual(visualSpecSchema.parse({ kind: "star", points: 6, tip_angle: 70, show_piece: true }))).toThrow(/divide/);
  });
});

describe("angles in the question must be the figure's angles", () => {
  const draft = (stem: string, answer: string, spec: unknown) => {
    const v = buildVisual(visualSpecSchema.parse(spec));
    return { stem, answer, type: "numeric" as const, figure: { spec: v.source === "program" ? spec : spec, svg: v.svg, description: v.description, source: v.source, verified: v.verified } };
  };
  const star = { kind: "star", points: 6, tip_angle: 76, divide: "tips", show_piece: true };

  it("passes the template's numbers and fails numbers the figure does not have", () => {
    expect(angleCheck(draft("The smallest angle in the quadrilateral is $38^\\circ$. How many degrees is the largest angle?", "224°", star))).toMatchObject({ ok: true });
    const wrong = angleCheck(draft("The smallest angle in the quadrilateral is $42^\\circ$. How many degrees is the largest angle?", "216°", star))!;
    expect(wrong.ok).toBe(false);
    expect(wrong.detail).toMatch(/42°.*216°/);
    // a wrong answer alone
    expect(angleCheck(draft("The smallest angle is 38°. What is the largest angle?", "222", star))!.ok).toBe(false);
    // no star, or no angle mentioned: not applicable
    expect(angleCheck(draft("How many tips does the star have?", "6", star))).toBeNull();
    expect(angleCheck(draft("What is 38° + 22°?", "60", { kind: "clock", hour: 3, minute: 0 }))).toBeNull();
  });
});

// ── Generation ───────────────────────────────────────────────────────

type Msg = { role: string; content: string | Array<{ type: string; text?: string }> };
const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p) => p.text).join(""));
let root: string;
let calls: Array<{ kind: string; system: string; user: string }>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bank-star-"));
  process.env.BANK_STORE_PATH = root;
  process.env.LLM_API_KEY = "k";
  process.env.LLM_BASE_URL = "https://llm.test/v1";
  process.env.LLM_MODEL = "m";
  process.env.LLM_VISION_MODEL = "v";
  process.env.LLM_LOG_LEVEL = "silent";
  process.env.LLM_CACHE_ENABLED = "false";
  resetGlobalCache();
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Msg[] };
      const sys = textOf(body.messages[0]);
      const user = textOf(body.messages[body.messages.length - 1]);
      const kind = sys.startsWith("You look at the figures")
        ? "template-visual"
        : sys.startsWith("You write new original")
          ? "generate"
          : sys.startsWith("You fix the figure specs")
            ? "repair"
            : sys.startsWith("You check a figure")
              ? "figure-check"
              : sys.startsWith("You solve math")
                ? "resolve"
                : sys.startsWith("You review generated")
                  ? "judge"
                  : sys.startsWith("You analyse a class")
                    ? "profile"
                    : "other";
      calls.push({ kind, system: sys, user });
      const reply = (c: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(c) } }] }), { status: 200 });
      switch (kind) {
        case "template-visual":
          return reply({ items: [{ n: 1, kind: "star", description: "a blue 6-point star; beside it one of its 6 identical concave quadrilaterals" }], style: { colour: "colour", accent: "#1d4ed8", fill: "#3b82f6", font: "sans", stroke: "normal", frame: "none" }, layout: "the star, then one piece beside it" });
        case "generate":
          return reply({
            questions: [
              // model-drawn: the star is not divided (the vision check fails, the repair redraws it as a program star)
              { stem: "This six-point star has 6 lines of symmetry. It can be cut into 6 identical quadrilaterals like this one. The smallest angle in the quadrilateral is $40^\\circ$. How many degrees is the largest angle?", type: "numeric", answer: "220°", figure: { kind: "svg", svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><polygon points='50,5 60,40 95,50 60,60 50,95 40,60 5,50 40,40' fill='blue'/></svg>", description: "a six-point star divided into 6 identical quadrilaterals, one drawn separately" } },
              // program-drawn, but its tip angle (76°) does not match the question (44°): repaired to tip 88°
              { stem: "A star with 6 lines of symmetry is cut into 6 identical quadrilaterals. The smallest angle in a quadrilateral is $44^\\circ$. Find the largest angle.", type: "numeric", answer: "212°", figure: { kind: "star", points: 6, tip_angle: 76, divide: "tips", show_piece: true } },
            ],
          });
        case "figure-check":
          return reply({ ok: false, problems: "the star has no lines dividing it into six quadrilaterals" });
        case "repair":
          return reply({
            fixes: [
              { n: 1, figure: { kind: "star", points: 6, tip_angle: 80, divide: "tips", show_division: false, show_piece: true } },
              { n: 2, figure: { kind: "star", points: 6, tip_angle: 88, divide: "tips", show_division: false, show_piece: true } },
            ],
          });
        case "resolve":
          return reply({ answers: [{ n: 1, answer: "220" }, { n: 2, answer: "212" }] });
        case "judge":
          return reply({ scores: [1, 2].map((n) => ({ n, score: 5, reason: "ok" })) });
        case "profile":
          return reply({ summary: "Angles in a piece of a symmetric star.", answer_form: "a number of degrees", stem_structure: "Star, piece, smallest angle; find the largest." });
        default:
          return reply({});
      }
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  _closeAllBanks();
  for (const v of ["BANK_STORE_PATH", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_VISION_MODEL", "LLM_LOG_LEVEL", "LLM_CACHE_ENABLED"]) delete process.env[v];
  fs.rmSync(root, { recursive: true, force: true });
});

describe("generating from the star template", () => {
  it("sends a failed model drawing and contradicting angles back, and checks the redrawn stars", async () => {
    const sharp = await loadSharp();
    const bank = createBank("local", { name: "Angles", language: "en" });
    const page = saveAsset("local", bank.id, encodePng({ data: new Uint8Array(60 * 40 * 3).fill(230), width: 60, height: 40, channels: 3 }), "png");
    const [item] = addItems("local", bank.id, [
      {
        origin: "imported",
        fields: { stem: "This star shape has 6 lines of symmetry.\nThe shape can be cut into 6 identical quadrilaterals that look like this.\nThe smallest angle in the quadrilateral is $38^\\circ$.\nHow many degrees is the largest angle in the quadrilateral?", type: "numeric", answer: "224", knowledge_points: [], tags: [], images: [{ asset: page, caption: "star: a blue six-point star" }] },
      },
    ]);
    const g = await generateFromTemplate({ owner: "local", bankId: bank.id, template: { item_ids: [item.id] }, count: 2 });
    const repairs = calls.filter((c) => c.kind === "repair");
    expect(repairs.length).toBeGreaterThan(0);
    // first round: the program star whose angles contradict the question; second: the model drawing the vision model rejected
    expect(repairs[0].user).toMatch(/(the figure's angles are|图中的角是).*44°/);
    if (sharp) expect(repairs[repairs.length - 1].user).toContain('draw it with a program kind from the guide if one fits (e.g. "star"');
    expect(repairs[0].system).toContain('{"kind":"star"');

    const first = g.candidates.find((c) => c.stem.includes("40^\\circ"))!;
    const second = g.candidates.find((c) => c.stem.includes("44^\\circ"))!;
    expect(second.figure?.spec).toMatchObject({ kind: "star", tip_angle: 88 });
    expect(second.checks.figure).toMatchObject({ ok: true });
    expect(second.checks.figure!.detail).toContain("44°");
    if (sharp) {
      expect(first.figure?.source).toBe("program");
      expect(first.figure?.spec).toMatchObject({ kind: "star", tip_angle: 80 });
      expect(first.checks.figure).toMatchObject({ ok: true });
      expect(first.passed).toBe(true);
    }
  });
});
