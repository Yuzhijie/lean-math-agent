import { bankRoute } from "@/lib/bank/http";
import { BankError } from "@/lib/bank/store";
import { lt } from "@/lib/llm/output-locale";
import { MarkingError, prepareWorkImages } from "@/lib/grading/mark";
import { MAX_PAPER_IMAGES } from "@/lib/grading/paper";
import { runPaper } from "@/lib/grading/paper-run";
import { accessToMember, discardPaperDraft, newPaperId, savePaperImages } from "@/lib/grading/store";
import type { Paper } from "@/lib/grading/types";
import { publicPaper } from "@/lib/grading/view";

export const maxDuration = 800;

const field = (form: FormData, k: string) => {
  const v = form.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

/**
 * POST multipart/form-data — mark a whole answered paper:
 *   member_id, images (1–12 page photos, in order), title,
 *   answer_key ("1. 3\n2. C …") and bank_id + generation_id (the printed bank worksheet) — the
 *   teacher's only; a student's paper is marked against answers solved by the model.
 * Streams NDJSON: {type:"progress", stage, done?, total?, message} … then {type:"result", paper} or {type:"error"}.
 */
export const POST = bankRoute(
  async ({ req, owner }) => {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new BankError(lt("请以表单上传（multipart/form-data）", "Send the paper as multipart/form-data"), 400);
    }
    const memberId = field(form, "member_id");
    if (!memberId) throw new BankError(lt("请选择学生", "Choose the student"), 400);
    const { member, role } = accessToMember(owner, memberId);
    const files = form.getAll("images").filter((f): f is File => f instanceof File && f.size > 0);
    let prepared: Awaited<ReturnType<typeof prepareWorkImages>>;
    try {
      prepared = await prepareWorkImages(await Promise.all(files.map(async (f) => ({ data: Buffer.from(await f.arrayBuffer()) }))), MAX_PAPER_IMAGES);
    } catch (e) {
      if (e instanceof MarkingError) throw new BankError(e.message, e.status);
      throw e;
    }
    const teacher = role === "teacher";
    const id = newPaperId();
    const paper: Paper = {
      id,
      class_id: member.class_id,
      member_id: member.id,
      submitted_by: owner,
      title: (field(form, "title") ?? "").slice(0, 200),
      images: savePaperImages(id, prepared.files),
      source: {
        ...(teacher && field(form, "answer_key") ? { answer_key: field(form, "answer_key")!.slice(0, 5000) } : {}),
        ...(teacher && field(form, "bank_id") && field(form, "generation_id") ? { bank_id: field(form, "bank_id"), generation_id: field(form, "generation_id") } : {}),
      },
      status: "failed",
      submission_ids: [],
      created_at: Date.now(),
    };

    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (o: unknown) => {
          try {
            controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
          } catch {
            /* closed */
          }
        };
        const beat = setInterval(() => send({ type: "ping" }), 15_000);
        try {
          const saved = await runPaper({ paper, member, imageUrls: prepared.urls, onProgress: (p) => send({ type: "progress", ...p }) });
          if (!saved) send({ type: "error", error: lt("这个学生在批改时被移除了", "The student was removed while marking") });
          else send({ type: "result", paper: publicPaper(saved, role) });
        } catch (e) {
          console.error("[grading/papers]", e);
          discardPaperDraft(id);
          send({ type: "error", error: lt(`批改失败：${e instanceof Error ? e.message : String(e)}`.slice(0, 300), `Marking failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)) });
        } finally {
          clearInterval(beat);
          try {
            controller.close();
          } catch {
            /* closed */
          }
        }
      },
    });
    return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" } });
  },
  { model: true },
);
