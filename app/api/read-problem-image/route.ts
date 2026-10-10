import { NextResponse } from "next/server";
import { BankError } from "@/lib/bank/store";
import { withRequestLocale, lt } from "@/lib/llm/output-locale";
import { MAX_PROBLEM_IMAGE_BYTES, ProblemImageError, readProblemImage } from "@/lib/problem-image";

export const maxDuration = 120;

/** POST multipart/form-data with `image`: the problem in the image as text (+ its figure described). */
async function handlePOST(req: Request) {
  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("image");
    file = f instanceof File ? f : null;
  } catch {
    /* not a form */
  }
  if (!file) return NextResponse.json({ error: lt("请上传一张图片（字段 image）", "Send one image (field “image”)") }, { status: 400 });
  if (file.size > MAX_PROBLEM_IMAGE_BYTES) return NextResponse.json({ error: lt("图片太大（最大 10 MB）", "The image is too large (10 MB at most)") }, { status: 413 });
  try {
    const result = await readProblemImage(Buffer.from(await file.arrayBuffer()));
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ProblemImageError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof BankError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("[read-problem-image]", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export const POST = withRequestLocale(handlePOST);
