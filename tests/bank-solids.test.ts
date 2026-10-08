import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cubeCount, hiddenTops, normaliseHeights, prepareStack, sideView, stackView } from "@/lib/figure/solid3d";
import { buildVisual, describeVisual, VISUAL_GUIDE, VISUAL_KINDS, visualSpecSchema } from "@/lib/figure/visual";
import { generateFromTemplate, templateSolids } from "@/lib/bank/generate";
import { usesFigure } from "@/lib/bank/profile";
import { encodePng } from "@/lib/bank/import/images";
import { _closeAllBanks, addItems, createBank, saveAsset } from "@/lib/bank/store";
import { resetGlobalCache } from "@/lib/llm/cache";

// 3D figures: stacks of unit cubes (with their views) and solids, drawn by
// the program; templates with 3D figures give questions with 3D figures.

const count = (svg: string, re: RegExp) => (svg.match(re) ?? []).length;

describe("cube stacks", () => {
  const heights = [
    [3, 2, 1],
    [2, 1, 0],
    [1, 0, 0],
  ];

  it("computes views, counts and trims empty rows/columns", () => {
    expect(cubeCount(heights)).toBe(10);
    expect(stackView(heights, "front")).toEqual([3, 2, 1]);
    expect(stackView(heights, "left")).toEqual([3, 2, 1]); // back → front
    expect(stackView([[1, 2], [3, 0]], "left")).toEqual([2, 3]);
    expect(stackView([[1, 2], [3, 0]], "right")).toEqual([3, 2]);
    expect(stackView(heights, "top")).toEqual([[1, 1, 1], [1, 1, 0], [1, 0, 0]]);
    expect(normaliseHeights([[0, 0, 0], [0, 2, 1], [0, 1]])).toEqual([[2, 1], [1, 0]]);
  });

  it("draws every cube with three faces and the views as squares", () => {
    const spec = visualSpecSchema.parse({ kind: "cube_stack", heights, views: [{ view: "front", label: "从正面看" }, { view: "top", label: "从上面看" }, { view: "left", blank: true, label: "从左面看" }] });
    const v = buildVisual(spec);
    expect(v.source).toBe("program");
    expect(v.verified).toBe(true);
    expect(count(v.svg, /<polygon /g)).toBe(30);
    // front view 3+2+1 squares, top view 6 squares
    expect(count(v.svg, /<rect x="\d+" y="\d+" width="22" height="22"/g)).toBe(12);
    expect(v.svg).toContain("从正面看");
    expect(v.svg).toContain('stroke-dasharray="2 3"'); // the empty grid
    const d = describeVisual(spec);
    expect(d).toContain("10 unit cubes");
    expect(d).toContain("back row first, left to right: [3, 2, 1] [2, 1, 0] [1, 0, 0]");
    expect(d).toContain('"从正面看" (front view): columns of squares, left to right, of heights 3, 2, 1');
    expect(d).toContain('an empty grid labelled "从左面看" (left view) for drawing that view');
    expect(d).not.toContain("cannot be seen");
  });

  it("isometric stacks, views only, and unusable specs", () => {
    expect(buildVisual(visualSpecSchema.parse({ kind: "cube_stack", heights: [[2, 3], [1, 1]], projection: "isometric" })).svg).toContain("<polygon");
    const only = visualSpecSchema.parse({ kind: "cube_stack", heights: [[1, 2]], show_stack: false, views: [{ view: "front" }] });
    expect(count(buildVisual(only).svg, /<polygon /g)).toBe(0);
    expect(describeVisual(only)).toContain("the solid itself is not drawn");
    expect(() => buildVisual(visualSpecSchema.parse({ kind: "cube_stack", heights: [[0, 0]] }))).toThrow(/no cubes/);
    expect(() => buildVisual(visualSpecSchema.parse({ kind: "cube_stack", heights: [[1]], show_stack: false }))).toThrow(/nothing to draw/);
    expect(visualSpecSchema.safeParse({ kind: "cube_stack", heights: [[9]] }).success).toBe(false);
  });

  it("notes cubes hidden by taller columns in front", () => {
    expect(hiddenTops([[1, 1], [3, 3]])).toBe(1);
    expect(hiddenTops([[3, 3], [1, 1]])).toBe(0);
    expect(describeVisual(visualSpecSchema.parse({ kind: "cube_stack", heights: [[1, 1], [3, 3]] }))).toContain("some cubes cannot be seen");
  });
});

describe("caps, plain blocks and plans", () => {
  const hall = { heights: [[3, 3, 3], [2, 2, 2], [1, 1, 1]], caps: [{ row: 0, col: 1, shape: "half_cylinder", axis: "y" }] };

  it("computes views with caps: outlines depend on the way the piece runs", () => {
    const st = prepareStack(hall.heights, hall.caps as never);
    const front = sideView(st, "front");
    expect(front.heights).toEqual([3, 3, 3]);
    expect(front.caps).toEqual([{ pos: 1, base: 3, outline: "semicircle", h: 0.5 }]);
    // From the side the half-cylinder running front–back shows as a rectangle, on the back column (positions run front → back).
    const side = sideView(st, "side");
    expect(side.heights).toEqual([1, 2, 3]);
    expect(side.caps).toEqual([{ pos: 2, base: 3, outline: "rect", h: 0.5 }]);
    // A cap on a lower column behind a taller one is hidden.
    expect(sideView(prepareStack([[1], [2]], [{ row: 0, col: 0, shape: "dome" }]), "front").caps).toEqual([]);
    // In front of a taller column it is seen.
    expect(sideView(prepareStack([[2], [1]], [{ row: 1, col: 0, shape: "cone" }]), "front").caps).toEqual([{ pos: 0, base: 1, outline: "triangle", h: 1 }]);
    // Caps keep their cells when empty rows/columns are trimmed.
    expect([...prepareStack([[0, 0], [0, 2]], [{ row: 1, col: 1, shape: "roof" }]).caps.keys()]).toEqual(["0,0"]);
  });

  it("draws plain blocks without lines between cubes, and describes caps", () => {
    const plain = buildVisual(visualSpecSchema.parse({ kind: "cube_stack", heights: [[1, 1, 1]], unit_lines: false }));
    const cubes = buildVisual(visualSpecSchema.parse({ kind: "cube_stack", heights: [[1, 1, 1]] }));
    // plain: faces are not outlined, only the block's edges are drawn; with unit lines every face is outlined
    expect(count(plain.svg, /<polygon [^>]*stroke="#1f1f1f"/g)).toBe(0);
    expect(count(plain.svg, /<line /g)).toBeGreaterThan(8);
    expect(count(cubes.svg, /<polygon [^>]*stroke="#1f1f1f"/g)).toBe(9);
    const v = buildVisual(visualSpecSchema.parse({ kind: "cube_stack", ...hall, unit_lines: false, views: [{ view: "front" }, { view: "side" }, { view: "top" }] }));
    expect(v.svg).toContain("<path d=\"M"); // the semicircle in the front view
    expect(v.description).toContain("drawn as plain blocks");
    expect(v.description).toContain("a half-cylinder (curved top running front–back) on top of the column in row 1 of 3 from the back, column 2 from the left");
    expect(v.description).toContain("the front view: columns of squares, left to right, of heights 3, 3, 3; a semicircle on top of column 2");
    expect(v.description).toContain("side (from the right) view: columns of squares, left to right, of heights 1, 2, 3; a rectangle on top of column 3");
    for (const shape of ["half_cylinder", "roof", "pyramid", "cylinder", "cone", "dome"]) {
      const b = buildVisual(visualSpecSchema.parse({ kind: "cube_stack", heights: [[1]], caps: [{ row: 0, col: 0, shape }], views: [{ view: "front" }, { view: "top" }] }));
      expect(b.verified, shape).toBe(true);
    }
    expect(() => buildVisual(visualSpecSchema.parse({ kind: "cube_stack", heights: [[1]], caps: [{ row: 3, col: 0, shape: "dome" }] }))).toThrow(/outside/);
  });
});

describe("solids", () => {
  it("draws polyhedra with hidden edges dashed (oblique) and labels on edges", () => {
    const v = buildVisual(visualSpecSchema.parse({ kind: "solid", shape: "cuboid", length: 6, width: 3, height: 4, labels: { length: "6 cm", width: "3 cm", height: "4 cm" } }));
    expect(count(v.svg, /<line [^>]*stroke-dasharray="5 4"/g)).toBe(3);
    expect(count(v.svg, /<line (?![^>]*stroke-dasharray)[^>]*\/>/g)).toBe(9);
    expect(count(v.svg, /<polygon /g)).toBe(3);
    for (const t of ["6 cm", "3 cm", "4 cm"]) expect(v.svg).toContain(`>${t}<`);
    expect(v.description).toBe('a cuboid (rectangular prism) drawn in 3D (oblique view) drawn in proportion length : width : height ≈ 6 : 3 : 4; length labelled "6 cm", width labelled "3 cm", height labelled "4 cm"; hidden edges dashed');

    const iso = buildVisual(visualSpecSchema.parse({ kind: "solid", shape: "cube", projection: "isometric" }));
    expect(iso.svg).not.toContain('stroke-dasharray="5 4"');
    expect(iso.description).toContain("hidden edges not drawn");

    const pyr = buildVisual(visualSpecSchema.parse({ kind: "solid", shape: "square_pyramid", labels: { height: "5 cm" } }));
    // 8 edges: the 2 back base edges and the edge up from the back corner are hidden, plus the dashed altitude.
    expect(count(pyr.svg, /stroke-dasharray="5 4"/g)).toBe(4);
    expect(pyr.svg).toContain(">5 cm<");
    for (const shape of ["triangular_prism", "triangular_pyramid"]) expect(buildVisual(visualSpecSchema.parse({ kind: "solid", shape })).verified).toBe(true);
  });

  it("draws round solids with the back of the base dashed", () => {
    for (const shape of ["cylinder", "cone", "sphere", "hemisphere"] as const) {
      const v = buildVisual(visualSpecSchema.parse({ kind: "solid", shape, radius: 3, height: 8, labels: { radius: "3 cm", ...(shape === "cylinder" || shape === "cone" ? { height: "8 cm" } : {}) } }));
      expect(v.svg, shape).toContain('stroke-dasharray="5 4"');
      expect(v.svg, shape).toContain(">3 cm<");
      expect(v.svg, shape).toContain('paint-order="stroke"'); // labels stay readable over lines
      expect(v.description, shape).toContain('radius labelled "3 cm"');
    }
  });

  it("works on cards and in the prompt guide", () => {
    const spec = visualSpecSchema.parse({ kind: "cards", columns: 2, cards: [{ label: "A", figure: { kind: "solid", shape: "cone" } }, { label: "B", figure: { kind: "cube_stack", heights: [[1, 2]] } }] });
    expect(describeVisual(spec)).toMatch(/card 1: "A", an upright cone.*card 2: "B", 3 unit cubes/);
    expect(VISUAL_KINDS).toEqual(expect.arrayContaining(["cube_stack", "solid"]));
    expect(VISUAL_GUIDE).toContain('{"kind":"cube_stack","heights"');
    expect(VISUAL_GUIDE).toContain('{"kind":"solid","shape"');
  });

  it("stems that point at 3D figures need one", () => {
    expect(usesFigure({ stem: "下面的立体图形是由几个小正方体搭成的？" })).toBe(true);
    expect(usesFigure({ stem: "从正面看到的形状是（ ）" })).toBe(true);
    expect(usesFigure({ stem: "Draw the front view of the stack of cubes." })).toBe(true);
    expect(usesFigure({ stem: "A cone holds 30 mL. How much water is in the cone after 10 mL is poured out?" })).toBe(false);
  });
});

// ── Generation ───────────────────────────────────────────────────────

type Msg = { role: string; content: string | Array<{ type: string; text?: string }> };
const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p) => p.text).join(""));
let root: string;
let calls: Array<{ kind: string; system: string; user: string }>;
let repairReply: unknown;
let extraQuestions: unknown[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bank-solids-"));
  process.env.BANK_STORE_PATH = root;
  process.env.LLM_API_KEY = "k";
  process.env.LLM_BASE_URL = "https://llm.test/v1";
  process.env.LLM_MODEL = "m";
  process.env.LLM_VISION_MODEL = "v";
  process.env.LLM_LOG_LEVEL = "silent";
  process.env.LLM_CACHE_ENABLED = "false";
  resetGlobalCache();
  calls = [];
  repairReply = {};
  extraQuestions = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Msg[] };
      const sys = textOf(body.messages[0]);
      const user = textOf(body.messages[body.messages.length - 1]);
      const kind = sys.startsWith("You look at the figures") ? "template-visual" : sys.startsWith("You write new original") ? "generate" : sys.startsWith("You solve math") ? "resolve" : sys.startsWith("You review generated") ? "judge" : sys.startsWith("You analyse a class") ? "profile" : sys.startsWith("You fix the figure specs") ? "repair" : "other";
      calls.push({ kind, system: sys, user });
      const reply = (c: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(c) } }] }), { status: 200 });
      if (kind === "template-visual")
        return reply({ items: [{ n: 1, kind: "cube_stack", description: "6 unit cubes in oblique view: back row 3 1, front row 1 1" }], style: { colour: "mono", accent: "#000000", fill: "#dddddd", font: "sans", stroke: "normal", frame: "none" }, layout: "the stack on the left, an empty grid for the front view on the right" });
      if (kind === "generate")
        return reply({
          questions: [
            { stem: "Mia builds a model from small cubes. How many small cubes did she use?", type: "multiple_choice", options: ["5", "6", "7", "8"], answer: "C", figure: { kind: "cube_stack", heights: [[3, 2], [1, 1]] } },
            { stem: "A stack has 2 cubes at the back and 1 in front. How many cubes?", type: "multiple_choice", options: ["2", "3", "4", "5"], answer: "B" },
            ...extraQuestions,
          ],
        });
      if (kind === "repair") return reply(repairReply);
      if (kind === "resolve") return reply({ answers: [{ n: 1, answer: "C" }, { n: 2, answer: "B" }, { n: 3, answer: "A" }] });
      if (kind === "judge") return reply({ scores: [1, 2].map((n) => ({ n, score: 5, reason: "ok" })) });
      if (kind === "profile") return reply({ summary: "Counting cubes in a stack.", answer_form: "one option letter", stem_structure: "A stack, then a question." });
      return reply({});
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  _closeAllBanks();
  for (const v of ["BANK_STORE_PATH", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_VISION_MODEL", "LLM_LOG_LEVEL", "LLM_CACHE_ENABLED"]) delete process.env[v];
  fs.rmSync(root, { recursive: true, force: true });
});

describe("generating from a template with 3D figures", () => {
  it("finds 3D kinds from the vision model or the import captions", () => {
    expect(templateSolids([{ images: [] }], ["clock", "solid"])).toEqual(["solid"]);
    expect(templateSolids([{ images: [{ asset: "a", caption: "cube_stack: back row 3 1, front row 1 1" }] }, { images: [] }], [])).toEqual(["cube_stack"]);
    expect(templateSolids([{ images: [{ asset: "a", caption: "clock: 3:00" }] }], [])).toEqual([]);
  });

  it("asks for a 3D figure, draws it, and fails a question without one", async () => {
    const bank = createBank("local", { name: "Cubes", language: "en" });
    const page = saveAsset("local", bank.id, encodePng({ data: new Uint8Array(60 * 40 * 3).fill(230), width: 60, height: 40, channels: 3 }), "png");
    const [item] = addItems("local", bank.id, [
      { origin: "imported", fields: { stem: "How many cubes are in the stack?", type: "multiple_choice", options: ["4", "5", "6", "7"], answer: "C", knowledge_points: [], tags: [], images: [{ asset: page, caption: "cube_stack: back row 3 1, front row 1 1" }] } },
    ]);
    const g = await generateFromTemplate({ owner: "local", bankId: bank.id, template: { item_ids: [item.id] }, count: 2 });
    const gen = calls.find((c) => c.kind === "generate")!;
    expect(gen.user).toContain("3D: the example questions show 3D figures. Every new question MUST include a program-drawn 3D figure");
    expect(gen.user).toContain('"show_stack": false and the views');
    expect(gen.system).toContain('{"kind":"cube_stack"');
    // The solver sees the exact stack.
    expect(calls.find((c) => c.kind === "resolve")!.user).toContain("7 unit cubes");

    const stack = g.candidates.find((c) => c.stem.startsWith("Mia builds"))!;
    expect(stack.figure?.source).toBe("program");
    expect(stack.checks.figure).toMatchObject({ ok: true });
    expect(stack.passed).toBe(true);
    const words = g.candidates.find((c) => c.stem.startsWith("A stack has"))!;
    expect(words.checks.figure).toMatchObject({ ok: false });
    expect(words.checks.figure!.detail).toMatch(/立体图形|3D figure/);
  });

  it("sends unusable or missing figures back once, with the error, and uses the fixed spec", async () => {
    extraQuestions = [
      { stem: "The plans show the front, side and top views of a hall. Which drawing shows the hall?", type: "multiple_choice", options: ["A", "B", "C", "D"], answer: "A", figure: { kind: "cards", columns: 1, cards: [{ figure: { kind: "views", front: [3, 2] } }] } },
    ];
    repairReply = {
      fixes: [
        { n: 2, figure: { kind: "cube_stack", heights: [[2], [1]] } },
        { n: 3, figure: { kind: "cards", columns: 1, cards: [{ label: "Plans", figure: { kind: "cube_stack", heights: [[3, 3], [2, 2]], caps: [{ row: 0, col: 0, shape: "half_cylinder", axis: "y" }], unit_lines: false, show_stack: false, views: [{ view: "front" }, { view: "side" }, { view: "top" }] } }, { label: "A", figure: { kind: "cube_stack", heights: [[3, 3], [2, 2]], caps: [{ row: 0, col: 0, shape: "half_cylinder", axis: "y" }], unit_lines: false, projection: "isometric" } }] } },
      ],
    };
    const bank = createBank("local", { name: "Plans", language: "en" });
    const page = saveAsset("local", bank.id, encodePng({ data: new Uint8Array(60 * 40 * 3).fill(230), width: 60, height: 40, channels: 3 }), "png");
    const [item] = addItems("local", bank.id, [
      { origin: "imported", fields: { stem: "How many cubes are in the stack?", type: "multiple_choice", options: ["4", "5", "6", "7"], answer: "C", knowledge_points: [], tags: [], images: [{ asset: page, caption: "cube_stack: back row 3 1, front row 1 1" }] } },
    ]);
    const g = await generateFromTemplate({ owner: "local", bankId: bank.id, template: { item_ids: [item.id] }, count: 3 });
    const repair = calls.find((c) => c.kind === "repair")!;
    expect(repair.system).toContain('{"kind":"cube_stack"');
    // The question without a 3D figure and the one with an unknown kind are sent back; the good one is not.
    expect(repair.user).toContain("a 3D figure (cube_stack) is required");
    expect(repair.user).toMatch(/cards\.0\.figure\.kind Invalid discriminator value.*\(got "views"\)/);
    expect(repair.user).toContain('Spec given: {"kind":"cards"');
    expect(repair.user).not.toContain("Mia builds");
    const words = g.candidates.find((c) => c.stem.startsWith("A stack has"))!;
    expect(words.figure?.spec).toMatchObject({ kind: "cube_stack" });
    expect(words.checks.figure).toMatchObject({ ok: true });
    const plans = g.candidates.find((c) => c.stem.startsWith("The plans show"))!;
    expect(plans.figure?.source).toBe("program");
    expect(plans.figure?.description).toContain("a semicircle on top of column 1");
    expect(plans.checks.figure).toMatchObject({ ok: true });
  });
});
