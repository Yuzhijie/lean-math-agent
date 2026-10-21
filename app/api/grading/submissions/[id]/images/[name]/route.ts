import { bankRoute } from "@/lib/bank/http";
import { readSubmissionImage } from "@/lib/grading/store";

type P = { id: string; name: string };

const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

/** A photo of a submission (its teacher or its student only). */
export const GET = bankRoute<P>(async ({ owner, params }) => {
  const data = readSubmissionImage(owner, params.id, params.name);
  const ext = params.name.split(".").pop()?.toLowerCase() ?? "jpg";
  return new Response(new Uint8Array(data), { headers: { "Content-Type": MIME[ext] ?? "application/octet-stream", "Cache-Control": "private, max-age=3600" } });
});
