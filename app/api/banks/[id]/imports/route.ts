import { NextResponse } from "next/server";
import { bankRoute } from "@/lib/bank/http";
import { detectFormat, parseImport, previewColumns } from "@/lib/bank/import";
import { BankError, getBank, listBatches } from "@/lib/bank/store";
import { IMPORT_FORMATS, type ImportFormat } from "@/lib/bank/types";
import { lt } from "@/lib/llm/output-locale";

type P = { id: string };
export const maxDuration = 480;

const MAX_BYTES = 30 * 1024 * 1024;

export const GET = bankRoute<P>(async ({ owner, params }) => ({
  batches: listBatches(owner, params.id).map(({ drafts, ...b }) => ({ ...b, draft_count: drafts.length })),
}));

/**
 * Upload a file (multipart field "file") → draft batch for review.
 * Optional fields: format, column_map (JSON), use_model ("false" to skip the model step).
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
  const file = form.get("file");
  if (!(file instanceof File)) throw new BankError(lt("缺少文件", "No file uploaded"), 400);
  if (file.size > MAX_BYTES) throw new BankError(lt("文件超过 30 MB", "File is larger than 30 MB"), 413);
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
  const batch = await parseImport({ owner, bankId: params.id, fileName: file.name, data, format, columnMap, useModel: form.get("use_model") !== "false" });
  return { batch };
});
