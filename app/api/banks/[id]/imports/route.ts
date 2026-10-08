import { NextResponse } from "next/server";
import { bankRoute } from "@/lib/bank/http";
import { detectFormat, parseImport, previewColumns } from "@/lib/bank/import";
import { BankError, getBank, listBatches } from "@/lib/bank/store";
import { IMPORT_FORMATS, type ImportFormat } from "@/lib/bank/types";
import { lt } from "@/lib/llm/output-locale";

type P = { id: string };
export const maxDuration = 480;

const MAX_BYTES = 30 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export const GET = bankRoute<P>(async ({ owner, params }) => ({
  batches: listBatches(owner, params.id).map(({ drafts, ...b }) => ({ ...b, draft_count: drafts.length })),
}));

/**
 * Upload a file (multipart field "file") → draft batch for review. Images (photos / screenshots of
 * pages) may be several "file" fields, read in order as the pages of one paper; scanned PDFs and
 * images are read by the vision model. The model's analysis of each scanned question as a
 * template is kept as its template_hint.
 * Optional fields: format, column_map (JSON), use_model ("false" to skip the model tidy-up of PDF text),
 * classify ("false" to skip model classification: catalogue place, grade, knowledge points, difficulty).
 * ?preview=columns → only the CSV/Excel header preview and suggested column mapping.
 */
export const POST = bankRoute<P>(async ({ req, owner, params }) => {
  getBank(owner, params.id);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new BankError(lt("请以 multipart/form-data 上传文件", "Upload the file as multipart/form-data"), 400);
  }
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  const file = files[0];
  if (!file) throw new BankError(lt("缺少文件", "No file uploaded"), 400);
  if (files.some((f) => f.size > MAX_BYTES)) throw new BankError(lt("文件超过 30 MB", "File is larger than 30 MB"), 413);
  if (files.reduce((s, f) => s + f.size, 0) > MAX_TOTAL_BYTES) throw new BankError(lt("文件合计超过 100 MB", "The files add up to more than 100 MB"), 413);
  const data = Buffer.from(await file.arrayBuffer());
  const fmtField = form.get("format");
  const format: ImportFormat = typeof fmtField === "string" && (IMPORT_FORMATS as readonly string[]).includes(fmtField) ? (fmtField as ImportFormat) : detectFormat(file.name, data);

  if (new URL(req.url).searchParams.get("preview") === "columns") {
    if (format !== "csv" && format !== "xlsx") throw new BankError(lt("只有 CSV / Excel 需要列映射", "Column mapping only applies to CSV / Excel"), 400);
    return NextResponse.json({ format, ...(await previewColumns(data, format)) });
  }

  let columnMap: Record<string, string> | undefined;
  const cm = form.get("column_map");
  if (typeof cm === "string" && cm.trim()) {
    try {
      columnMap = JSON.parse(cm) as Record<string, string>;
    } catch {
      throw new BankError(lt("column_map 不是有效的 JSON", "column_map is not valid JSON"), 400);
    }
  }
  // Several files form one batch only as page images (photos of a multi-page paper), in upload order.
  if (files.length > 1 && format !== "image") {
    throw new BankError(lt("一次只能上传一个文件；多个文件只适用于图片（同一份试卷的多页照片）", "Upload one file at a time; several files are only accepted as images (pages of the same paper)"), 400);
  }
  const moreImages = await Promise.all(files.slice(1).map(async (f) => ({ fileName: f.name, data: Buffer.from(await f.arrayBuffer()) })));
  const batch = await parseImport({
    owner,
    bankId: params.id,
    fileName: file.name,
    data,
    format,
    columnMap,
    useModel: form.get("use_model") !== "false",
    classify: form.get("classify") !== "false",
    moreImages,
  });
  return { batch };
});
