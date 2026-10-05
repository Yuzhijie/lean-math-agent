/**
 * Figures that come with a problem (question bank images, sent along when
 * a bank question is used on the solving page).
 *
 * The solving pipeline is text-only (classification, equation setup,
 * natural-language solution, autoformalization, Lean provers), so the
 * figures are read once by the vision model (role "vision") into a precise
 * description of what is drawn — labels, lengths, angles, marks, axes,
 * data — which is appended to the problem text. Every later step then has
 * the figure's information, and the user sees exactly what was read.
 */
import { z } from "zod";
import { chatJson } from "@/lib/llm/client";
import { lt } from "@/lib/llm/output-locale";
import { detectImage, preparePhoto } from "./import/images";
import { getBank, readAsset } from "./store";

export const figureRefsSchema = z
  .array(z.object({ bank_id: z.string().min(1).max(64), asset: z.string().regex(/^[a-f0-9]{16,64}\.(png|jpe?g|gif|webp)$/) }))
  .max(6);
export type FigureRef = z.infer<typeof figureRefsSchema>[number];

const describeSchema = z.object({
  description: z.string().default(""),
  readable: z.boolean().nullish(),
});

const SYSTEM = `You read the figure(s) that belong to a maths problem, for a solver that cannot see them.
Describe precisely everything drawn that a solver needs: the shapes and how they are placed, every labelled point, the given lengths, angles and other values exactly as written (with units), marks for equal sides, right angles, parallel lines and tangents, axes with their scales, plotted points and lines, values in charts and tables, and any text in the figure.
Rules:
- Report only what is drawn or written. Do not solve the problem, do not compute anything, and do not guess measures that are not marked; say "not marked" where it matters.
- Write maths in LaTeX between $ … $. Keep it compact: short sentences or a list.
- Write in the same language as the problem text.
Return JSON: {"description":"…","readable":true}. Set "readable": false if the image cannot be read.`;

/** Read the figures into a text description; never throws (a failure is reported as `note`). */
export async function describeProblemFigures(args: {
  owner: string;
  problemText: string;
  figures: FigureRef[];
}): Promise<{ description?: string; note?: string }> {
  const images: string[] = [];
  try {
    for (const f of args.figures) {
      const bank = getBank(args.owner, f.bank_id);
      if (!bank.allow_model) return { note: lt("题目图形所在的题库不允许发送给模型，已按文字求解", "The figure's bank does not allow sending content to the model; solving from the text only") };
      const data = readAsset(args.owner, f.bank_id, f.asset);
      if (!detectImage(data)) continue;
      const img = await preparePhoto(data, images.length + 1);
      images.push(`data:${img.mime};base64,${img.data.toString("base64")}`);
    }
  } catch (e) {
    return { note: lt(`无法读取题目图形：${(e as Error).message}`.slice(0, 200), `Could not load the problem's figure: ${(e as Error).message}`.slice(0, 200)) };
  }
  if (!images.length) return {};
  if (!process.env.LLM_API_KEY) return { note: lt("未配置模型，无法读取题目图形", "No model is configured; the figure was not read") };
  try {
    const res = await chatJson({
      role: "vision",
      system: SYSTEM,
      user: `Problem text:\n${args.problemText.slice(0, 4000)}\n\nDescribe the attached figure${images.length > 1 ? "s" : ""} as JSON.`,
      images,
      schema: describeSchema,
      schemaName: "problem_figure_description",
      temperature: 0,
      maxTokens: 2000,
      maxRetries: 1,
      keepLanguage: true,
    });
    const description = res.description.trim();
    if (res.readable === false || !description) return { note: lt("模型无法辨认题目图形，已按文字求解", "The model could not read the figure; solving from the text only") };
    return { description: description.slice(0, 4000) };
  } catch (e) {
    return {
      note: lt(
        `读取题目图形失败（${(e as Error).message}`.slice(0, 160) + "），已按文字求解。请确认所配置的模型能读取图片（LLM_VISION_MODEL）。",
        `Reading the figure failed (${(e as Error).message}`.slice(0, 160) + "); solving from the text only. Make sure the configured model accepts images (LLM_VISION_MODEL).",
      ),
    };
  }
}

/** Problem text with the figure description appended, as every solving step will see it. */
export function problemWithFigure(problemText: string, description: string): string {
  return `${problemText.trim()}\n\n${lt("【题目图形（由模型从图中读取）】", "[Figure, as read from the image by the model]")}\n${description}`;
}
