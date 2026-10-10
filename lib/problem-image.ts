/**
 * A problem pasted or dropped onto the solving page as an image (screenshot, photo):
 * the vision model transcribes the question text verbatim and, when there is a figure,
 * describes it exactly (like lib/bank/problem-figures.ts), so the solver gets both.
 * Nothing is stored; the image is only sent to the model.
 */
import { z } from "zod";
import { chatJson } from "@/lib/llm/client";
import { lt } from "@/lib/llm/output-locale";
import { detectImage, preparePhoto } from "@/lib/bank/import/images";

export const MAX_PROBLEM_IMAGE_BYTES = 10 * 1024 * 1024;

const readSchema = z.object({
  readable: z.boolean().nullish(),
  question: z.string().default(""),
  has_figure: z.boolean().nullish(),
  figure: z.string().nullish(),
});

export const READ_PROBLEM_SYSTEM = `You read a maths problem from an image (a screenshot or photo) for a solver that cannot see it.
1. "question": transcribe the problem text exactly as written — every word, number and unit; keep line breaks; multiple-choice options one per line as "A. …". Write maths in LaTeX between $ … $. Do not solve it, do not add or drop anything. If the image has several problems, transcribe only the first complete one.
2. "figure": if the problem has a diagram, chart, table drawn as a picture or any other figure, describe precisely everything a solver needs: shapes and how they are placed, labelled points, given lengths, angles and values exactly as written (with units), marks for equal sides, right angles and parallel lines, axes and scales, plotted values, text in the figure. Report only what is drawn; say "not marked" where it matters. Leave it empty when there is no figure.
Write in the language of the problem. Return JSON: {"readable":true,"question":"…","has_figure":false,"figure":""}. Set "readable": false if no maths problem can be read.`;

export interface ReadProblemImageResult {
  text: string;
  figure?: string;
}

export class ProblemImageError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
  }
}

export async function readProblemImage(data: Buffer): Promise<ReadProblemImageResult> {
  if (data.length > MAX_PROBLEM_IMAGE_BYTES) throw new ProblemImageError(lt("图片太大（最大 10 MB）", "The image is too large (10 MB at most)"), 413);
  const kind = detectImage(data);
  if (!kind) throw new ProblemImageError(lt("不是可识别的图片（支持 PNG、JPEG、GIF、WebP）", "Not a recognised image (PNG, JPEG, GIF or WebP)"), 415);
  if (!process.env.LLM_API_KEY) throw new ProblemImageError(lt("未配置模型，无法读取图片", "No model is configured, so the image cannot be read"), 503);
  // HEIC is refused here with a message saying how to convert it.
  const img = await preparePhoto(data, 1);
  let res: z.infer<typeof readSchema>;
  try {
    res = await chatJson({
      role: "vision",
      system: READ_PROBLEM_SYSTEM,
      user: "Read the maths problem in the attached image and return the JSON.",
      images: [`data:${img.mime};base64,${img.data.toString("base64")}`],
      schema: readSchema,
      schemaName: "problem_from_image",
      temperature: 0,
      maxTokens: 3000,
      maxRetries: 1,
      keepLanguage: true,
    });
  } catch (e) {
    throw new ProblemImageError(
      lt(
        `读取图片失败（${(e as Error).message}`.slice(0, 160) + "）。请确认所配置的模型能读取图片（LLM_VISION_MODEL）。",
        `Reading the image failed (${(e as Error).message}`.slice(0, 160) + "). Make sure the configured model accepts images (LLM_VISION_MODEL).",
      ),
      502,
    );
  }
  const text = res.question.trim();
  if (res.readable === false || !text) throw new ProblemImageError(lt("图片里没有读到数学题，请换一张更清楚的图", "No maths problem could be read from the image; try a clearer one"));
  const figure = res.has_figure !== false ? res.figure?.trim() : "";
  return { text: text.slice(0, 8000), ...(figure ? { figure: figure.slice(0, 4000) } : {}) };
}
