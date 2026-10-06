/**
 * The template's figures, read by the vision model before generation.
 *
 * Template questions that came from scans and photos keep their figures
 * (and page images) as bank assets. The model that writes new questions
 * reads text only, so the vision model (role "vision") looks at the
 * figures once and returns, per template question, an exact description
 * of its figure and the kind of figure it is, plus the visual style of
 * the set (colour or black-and-white, accent colours, font feel, line
 * weight, frames). The descriptions go into the generation prompt and the
 * style is used to draw the new questions' figures (lib/figure/visual.ts).
 * Only layout and style are imitated — never illustrations, logos or
 * brand names.
 */
import { z } from "zod";
import { chatJson } from "../llm/client";
import { DEFAULT_STYLE, figureStyleSchema, VISUAL_KINDS, type FigureStyle } from "../figure/visual";
import { detectImage, preparePhoto } from "./import/images";
import { readAsset } from "./store";
import type { Item } from "./types";

export interface TemplateVisuals {
  style: FigureStyle;
  /** Figure description per template item id. */
  descriptions: Map<string, string>;
  /** Kinds of figure the template uses (e.g. clock, cards, bar_chart). */
  kinds: string[];
  /** How figures are laid out with the question (one line). */
  layout?: string;
  /** Why the figures could not be read (generation then works from the text). */
  note?: string;
}

const MAX_TEMPLATES = 4;

const SYSTEM = `You look at the figures of example maths questions so that new questions of the same kind can be drawn in the same style.
For each example question you get its text and its figure image(s) (or the page it is on). Return:
- "items": for each example n, "description": an exact description of what its figure shows (every label, number, time, value, shape and how they are arranged; no solving), and "kind": the closest of ${VISUAL_KINDS.join(", ")} ("cards" when several pictures are laid out as cards or boxes; "svg" when none fits).
- "style": the visual style of these figures — "colour": "colour" or "mono"; "accent": main outline/heading colour as #rrggbb; "fill": light fill colour as #rrggbb; "font": "rounded" | "sans" | "serif" | "handwriting"; "stroke": "thin" | "normal" | "bold"; "frame": "none" | "box" | "rounded" | "dashed" (how figures or cards are framed).
- "layout": one sentence on how the figure sits with the question (e.g. "a row of 4 cut-out cards, each with a time label, a clock and an answer box").
Ignore handwriting, logos, brand names, page decorations and illustrations that carry no information. Write descriptions in the language of the question text.
Return JSON only: {"items":[{"n":1,"description":"…","kind":"clock"}],"style":{…},"layout":"…"}`;

const responseSchema = z.object({
  items: z.array(z.object({ n: z.coerce.number(), description: z.string().default(""), kind: z.string().optional().default("svg") })).default([]),
  style: z.unknown().optional(),
  layout: z.string().optional(),
});

/** Images that show an item's figure: its figures, else the page it was read from. */
function imageAssets(it: Item): string[] {
  const figs = it.images.map((im) => im.asset);
  if (figs.length) return figs.slice(0, 2);
  return it.source?.page_image ? [it.source.page_image] : [];
}

export function hasTemplateImages(items: Item[]): boolean {
  return items.some((it) => imageAssets(it).length > 0);
}

/** Read the template's figures and style. Never throws: on failure the note says why. */
export async function readTemplateVisuals(owner: string, bankId: string, items: Item[]): Promise<TemplateVisuals> {
  const empty: TemplateVisuals = { style: DEFAULT_STYLE, descriptions: new Map(), kinds: [] };
  const withImages = items.filter((it) => imageAssets(it).length).slice(0, MAX_TEMPLATES);
  if (!withImages.length) return empty;
  const images: string[] = [];
  const blocks: string[] = [];
  try {
    for (const [i, it] of withImages.entries()) {
      const urls: string[] = [];
      for (const a of imageAssets(it)) {
        const data = readAsset(owner, bankId, a);
        if (!detectImage(data)) continue;
        const img = await preparePhoto(data, images.length + 1);
        urls.push(`data:${img.mime};base64,${img.data.toString("base64")}`);
      }
      if (!urls.length) continue;
      blocks.push(`Example ${i + 1} (image${urls.length > 1 ? `s ${images.length + 1}–${images.length + urls.length}` : ` ${images.length + 1}`}${it.images.length ? "" : ", the whole page"}):\n${it.stem.slice(0, 1200)}${it.options?.length ? "\n" + it.options.map((o, k) => `${String.fromCharCode(65 + k)}. ${o}`).join("\n") : ""}`);
      images.push(...urls);
    }
  } catch (e) {
    return { ...empty, note: `figures could not be loaded: ${(e as Error).message}`.slice(0, 200) };
  }
  if (!images.length) return empty;
  try {
    const res = await chatJson({
      role: "vision",
      system: SYSTEM,
      user: `${blocks.join("\n\n")}\n\nDescribe the figures and their style as JSON.`,
      images,
      schema: responseSchema,
      schemaName: "template_visuals",
      temperature: 0,
      maxTokens: 3000,
      maxRetries: 1,
      keepLanguage: true,
    });
    const style = figureStyleSchema.safeParse(res.style ?? {});
    const descriptions = new Map<string, string>();
    const kinds = new Set<string>();
    for (const r of res.items) {
      const it = withImages[Math.round(r.n) - 1];
      if (it && r.description.trim()) descriptions.set(it.id, r.description.trim().slice(0, 1500));
      if ((VISUAL_KINDS as readonly string[]).includes(r.kind)) kinds.add(r.kind);
    }
    return { style: style.success ? style.data : DEFAULT_STYLE, descriptions, kinds: [...kinds], layout: res.layout?.trim().slice(0, 300) };
  } catch (e) {
    return { ...empty, note: `the vision model could not read the figures: ${(e as Error).message}`.slice(0, 240) };
  }
}
