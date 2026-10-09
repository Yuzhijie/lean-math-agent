import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outsideSides, rowShape } from "@/lib/figure/tiles";
import { buildVisual, VISUAL_GUIDE, visualSpecSchema } from "@/lib/figure/visual";
import { generateFromTemplate, tileRowCheck } from "@/lib/bank/generate";
import { encodePng } from "@/lib/bank/import/images";
import { _closeAllBanks, addItems, createBank, saveAsset } from "@/lib/bank/store";
import { resetGlobalCache } from "@/lib/llm/cache";

// "Peter had some triangular tiles with sides 3 cm long. He placed them side by side to make a
// trapezium. If the perimeter of the trapezium was 27 cm, how many tiles did Peter use?" (7)

const ROW = { kind: "tile_row", tile: "triangle", tiles: 2, shaded: 1, dashed_from: 2, continues: true };

describe("tiles in a row", () => {
  it("counts the sides around the outside and names the shape", () => {
    expect([1, 2, 3, 6, 7].map((n) => outsideSides("triangle", n))).toEqual([3, 4, 5, 8, 9]);
    expect(outsideSides("square", 4)).toBe(10);
    expect(outsideSides("hexagon", 3)).toBe(14);
    expect(rowShape("triangle", 7)).toBe("trapezium");
    expect(rowShape("triangle", 6)).toBe("parallelogram");
  });

  it("draws the template's figure: one shaded tile, one dashed, the row going on", () => {
    const v = buildVisual(visualSpecSchema.parse({ ...ROW, side_label: "3 cm" }));
    expect(v.source).toBe("program");
    expect(v.svg.match(/<polygon /g)?.length).toBe(2);
    expect(v.svg.match(/stroke-dasharray="6 4"/g)?.length).toBe(3); // the dashed tile and the two lines
    expect(v.description).toContain("alternately pointing up and down: 2 tiles drawn; the first 1 shaded; 1 drawn as dashed outline; dashed lines along the top and bottom show that the row continues (the total number of tiles is not shown)");
    expect(VISUAL_GUIDE).toContain('{"kind":"tile_row"');
  });
});

describe("the program checks the perimeter and the shape", () => {
  const q = (stem: string, options: string[], answer: string, side = "") => {
    const spec = { ...ROW, ...(side ? { side_label: side } : {}) };
    const v = buildVisual(visualSpecSchema.parse(spec));
    return { stem, type: "multiple_choice" as const, options, answer, figure: { spec, svg: v.svg, description: v.description, source: "program" as const, verified: true } };
  };

  it("passes the template and the correct generated question", () => {
    expect(tileRowCheck(q("Peter had some triangular tiles with sides 3 cm long.\nHe placed them side by side to make a trapezium.\n\nIf the perimeter of the trapezium was 27 cm, how many tiles did Peter use?", ["3", "5", "7", "9"], "C"))).toEqual({ mismatch: false, detail: expect.stringContaining("9 × 3 = 27") });
    expect(tileRowCheck(q("A craft club used equal-sided triangular tiles, each with sides 5 cm long.\nThe tiles were arranged side by side to make a trapezium.\n\nThe perimeter of the trapezium was 45 cm. How many triangular tiles were used?", ["5", "6", "7", "9"], "C"))!.mismatch).toBe(false);
  });

  it("fails 6 triangles called a trapezium, and a wrong count", () => {
    const six = tileRowCheck(q("Maya had some triangular tiles with sides 4 cm long.\nShe placed them side by side to make a trapezium.\n\nIf the perimeter of the trapezium was 32 cm, how many tiles did Maya use?", ["4", "6", "8", "10"], "B"))!;
    expect(six.mismatch).toBe(true);
    expect(six.detail).toMatch(/parallelogram|平行四边形/);
    const wrong = tileRowCheck(q("Peter had some triangular tiles with sides 3 cm long. He placed them side by side to make a trapezium. The perimeter was 27 cm. How many tiles did Peter use?", ["3", "5", "7", "9"], "D"))!;
    expect(wrong.mismatch).toBe(true);
    expect(wrong.detail).toMatch(/33/); // 9 tiles: 11 sides × 3
    // the perimeter asked for, the count given
    expect(tileRowCheck({ ...q("Sam put 5 triangular tiles with sides 2 cm long side by side. What is the perimeter of the shape?", ["10 cm", "12 cm", "14 cm", "16 cm"], "C"), type: "multiple_choice" })!.mismatch).toBe(false);
    // no tile row: not applicable
    expect(tileRowCheck({ stem: "The perimeter is 27 cm.", type: "numeric", answer: "7", figure: undefined })).toBeNull();
  });
});

// ── Generation ───────────────────────────────────────────────────────

type Msg = { role: string; content: string | Array<{ type: string; text?: string }> };
const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p) => p.text).join(""));
let root: string;
let calls: Array<{ kind: string; system: string; user: string }>;
const TEMPLATE = "Peter had some triangular tiles with sides 3 cm long.\nHe placed them side by side to make a trapezium.\n\nIf the perimeter of the trapezium was 27 cm, how many tiles did Peter use?";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bank-tiles-"));
  process.env.BANK_STORE_PATH = root;
  process.env.LLM_API_KEY = "k";
  process.env.LLM_BASE_URL = "https://llm.test/v1";
  process.env.LLM_MODEL = "m";
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
      const kind = sys.startsWith("You look at the figures") ? "template-visual" : sys.startsWith("You write new original") ? "generate" : sys.startsWith("You fix the figure specs") ? "repair" : sys.startsWith("You reword generated") ? "reword" : sys.startsWith("You solve math") ? "resolve" : sys.startsWith("You review generated") ? "judge" : sys.startsWith("You analyse a class") ? "profile" : "other";
      calls.push({ kind, system: sys, user });
      const reply = (c: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(c) } }] }), { status: 200 });
      switch (kind) {
        case "template-visual":
          return reply({ items: [{ n: 1, kind: "tile_row", description: "one shaded triangle, one dashed, dashed lines along top and bottom" }], style: { colour: "colour", accent: "#be185d", fill: "#f9a8d4", font: "sans", stroke: "normal", frame: "none" } });
        case "generate":
          return reply({
            questions: [
              // 6 triangles called a trapezium; the stem copies the template
              { stem: "Maya had some triangular tiles with sides 4 cm long.\nShe placed them side by side to make a trapezium.\n\nIf the perimeter of the trapezium was 32 cm, how many tiles did Maya use?", type: "multiple_choice", options: ["4", "6", "8", "10"], answer: "B", figure: { ...ROW, side_label: "4 cm" } },
              // correct, but the geometry op does not exist (an alias is accepted)
              { stem: "A craft club used equal-sided triangular tiles, each with sides 5 cm long.\nThe tiles were arranged side by side to make a trapezium.\n\nThe perimeter of the trapezium was 45 cm. How many triangular tiles were used?", type: "multiple_choice", options: ["5", "6", "7", "9"], answer: "C", figure: { kind: "geometry", spec: { needed: true, constructions: [{ op: "equilateral_triangle", ids: ["A", "B", "C"], side: 5 }], draw: [], claims: [] } } },
              // a kind that does not exist, and the redraw does not help
              { stem: "Lena used square tiles with sides 2 cm long in a row. The perimeter of the rectangle was 22 cm. How many tiles did Lena use?", type: "multiple_choice", options: ["4", "5", "6", "7"], answer: "B", figure: { kind: "tiles", count: 5 } },
            ],
          });
        case "repair":
          return reply({ fixes: [{ n: 3, figure: { kind: "tile_rows", tile: "square" } }] });
        case "reword":
          // changes 32 to 30: must not be used
          return reply({ stems: [{ n: 1, stem: "In art class, Maya laid triangle tiles with 4 cm sides in a line to form a trapezium with a perimeter of 30 cm. How many tiles?" }] });
        case "resolve":
          return reply({ answers: [{ n: 1, answer: "B" }, { n: 2, answer: "C" }, { n: 3, answer: "B" }] });
        case "judge":
          return reply({ scores: [1, 2, 3].map((n) => ({ n, score: 4, reason: "ok" })) });
        case "profile":
          return reply({ summary: "Triangular tiles in a row; perimeter → number of tiles.", answer_form: "one option letter", stem_structure: "Tiles, shape, perimeter; how many tiles?" });
        default:
          return reply({});
      }
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  _closeAllBanks();
  for (const v of ["BANK_STORE_PATH", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_LOG_LEVEL", "LLM_CACHE_ENABLED"]) delete process.env[v];
  fs.rmSync(root, { recursive: true, force: true });
});

describe("generating from the tiles template", () => {
  it("checks the tile count, accepts the geometry alias, and says what the repair and rewording did", async () => {
    const bank = createBank("local", { name: "Tiles", language: "en" });
    const page = saveAsset("local", bank.id, encodePng({ data: new Uint8Array(60 * 40 * 3).fill(230), width: 60, height: 40, channels: 3 }), "png");
    const [item] = addItems("local", bank.id, [{ origin: "imported", fields: { stem: TEMPLATE, type: "multiple_choice", options: ["3", "5", "7", "9"], answer: "C", knowledge_points: [], tags: [], images: [{ asset: page, caption: "tile_row: one shaded triangle tile, then a dashed one" }] } }]);
    const g = await generateFromTemplate({ owner: "local", bankId: bank.id, template: { item_ids: [item.id] }, count: 3 });
    expect(calls.find((c) => c.kind === "judge")!.system).toContain("do not lower the score because you think the answer is wrong");

    const maya = g.candidates.find((c) => c.stem.includes("Maya"))!;
    expect(maya.checks.answer).toMatchObject({ ok: false });
    expect(maya.checks.answer!.detail).toMatch(/parallelogram|平行四边形/);
    expect(maya.checks.novelty).toMatchObject({ ok: false });
    expect(maya.checks.novelty!.detail).toMatch(/changed a number|数字变了/);

    const club = g.candidates.find((c) => c.stem.includes("craft club"))!;
    expect(club.figure?.source).toBe("program");
    expect(club.checks.figure).toMatchObject({ ok: true });

    const lena = g.candidates.find((c) => c.stem.includes("Lena"))!;
    expect(lena.checks.figure).toMatchObject({ ok: false });
    expect(lena.checks.figure!.detail).toMatch(/still unusable after one redraw|重画一次仍无效/);
  });
});
