/**
 * Customer question banks (试题库): data model.
 *
 * A bank belongs to one account and holds items (questions), categories
 * (a tree of manual groups, saved filters or style templates), import
 * batches (drafts awaiting review) and generations (candidate questions
 * made from a template, adopted by hand). Everything is plain JSON so it
 * can be stored in SQLite or JSONL alike and exported as-is.
 */
import { z } from "zod";

export const BANK_SCHEMA_VERSION = 1;

export const QUESTION_TYPES = ["multiple_choice", "numeric", "short_answer", "proof", "other"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

const id = z.string().min(1).max(64);
const ts = z.number().int();

export const assetRefSchema = z.object({
  /** File name inside the bank's assets/ folder. */
  asset: z.string().min(1).max(200),
  caption: z.string().max(200).optional(),
});

export const itemSourceSchema = z.object({
  file: z.string().max(300).optional(),
  page: z.number().int().positive().optional(),
  /** Question number / label in the source, e.g. "12" or "例3". */
  label: z.string().max(40).optional(),
});

/** Fields a question has, before it is stored (drafts, candidates, manual entry). */
export const itemFieldsSchema = z.object({
  stem: z.string().min(1).max(20_000),
  type: z.enum(QUESTION_TYPES).default("other"),
  /** Choices for multiple choice, in order (A, B, C, …), without the letter. */
  options: z.array(z.string().max(2000)).max(10).optional(),
  answer: z.string().max(5000).optional(),
  solution: z.string().max(20_000).optional(),
  grade: z.string().max(40).optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  knowledge_points: z.array(z.string().max(80)).max(20).default([]),
  tags: z.array(z.string().max(60)).max(30).default([]),
  images: z.array(assetRefSchema).max(20).default([]),
  source: itemSourceSchema.optional(),
  language: z.enum(["zh", "en"]).optional(),
});
export type ItemFields = z.infer<typeof itemFieldsSchema>;

export const itemSchema = itemFieldsSchema.extend({
  id,
  bank_id: id,
  category_ids: z.array(id).default([]),
  origin: z.enum(["imported", "generated", "manual"]),
  /** Set for generated items: which template and generation they came from. */
  generated_from: z.object({ generation_id: id, template_label: z.string().max(200) }).optional(),
  /** Hash of the normalised stem (exact-duplicate detection). */
  fingerprint: z.string(),
  created_at: ts,
  updated_at: ts,
  schema_version: z.number().int().default(BANK_SCHEMA_VERSION),
});
export type Item = z.infer<typeof itemSchema>;

export const bankSchema = z.object({
  id,
  /** Account id (NextAuth user id) or "local". */
  owner: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  /** Language of the bank's questions; generation can be pinned to it. */
  language: z.enum(["zh", "en", "mixed"]).default("mixed"),
  /** Generated questions follow the bank language instead of the UI language. */
  pin_language: z.boolean().default(false),
  /** Whether bank content may be sent to the configured model service. */
  allow_model: z.boolean().default(true),
  /** Customer's own knowledge-point vocabulary (used before the built-in curriculum list). */
  vocab: z.array(z.string().max(80)).max(2000).default([]),
  created_at: ts,
  updated_at: ts,
  schema_version: z.number().int().default(BANK_SCHEMA_VERSION),
});
export type Bank = z.infer<typeof bankSchema>;

/** Describes a type of question without source questions (e.g. ICAS-style). */
export const styleTemplateSchema = z.object({
  grade: z.string().max(40).optional(),
  knowledge_points: z.array(z.string().max(80)).max(20).default([]),
  type: z.enum(QUESTION_TYPES).default("multiple_choice"),
  /** Number of options for multiple choice. */
  option_count: z.number().int().min(2).max(8).optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  with_figure: z.boolean().optional(),
  language: z.enum(["zh", "en"]).optional(),
  /** Free description of the style: context, wording, units, what is typical. */
  notes: z.string().max(3000).optional(),
});
export type StyleTemplate = z.infer<typeof styleTemplateSchema>;

export const itemFilterSchema = z.object({
  query: z.string().max(200).optional(),
  types: z.array(z.enum(QUESTION_TYPES)).optional(),
  grades: z.array(z.string().max(40)).optional(),
  knowledge_points: z.array(z.string().max(80)).optional(),
  tags: z.array(z.string().max(60)).optional(),
  difficulty_min: z.number().int().min(1).max(5).optional(),
  difficulty_max: z.number().int().min(1).max(5).optional(),
  origin: z.enum(["imported", "generated", "manual"]).optional(),
  category_id: id.optional(),
});
export type ItemFilter = z.infer<typeof itemFilterSchema>;

/** What a class of questions has in common — derived once, cached on the category. */
export const templateProfileSchema = z.object({
  summary: z.string().max(2000),
  type: z.enum(QUESTION_TYPES),
  option_count: z.number().int().min(2).max(8).optional(),
  knowledge_points: z.array(z.string().max(80)).max(20).default([]),
  grade: z.string().max(40).optional(),
  difficulty_range: z.tuple([z.number().int().min(1).max(5), z.number().int().min(1).max(5)]).optional(),
  answer_form: z.string().max(300).optional(),
  stem_structure: z.string().max(1000).optional(),
  needs_figure: z.boolean().default(false),
  language: z.enum(["zh", "en"]).optional(),
  exemplar_ids: z.array(id).default([]),
  /** Hash of the member items when computed; a different hash = stale. */
  items_hash: z.string(),
  computed_at: ts,
});
export type TemplateProfile = z.infer<typeof templateProfileSchema>;

export const categorySchema = z.object({
  id,
  bank_id: id,
  name: z.string().min(1).max(100),
  parent_id: id.nullable().default(null),
  /** manual: items assigned by hand; filter: saved filter; style: style template (no source items needed). */
  kind: z.enum(["manual", "filter", "style"]).default("manual"),
  filter: itemFilterSchema.optional(),
  style: styleTemplateSchema.optional(),
  profile: templateProfileSchema.optional(),
  created_at: ts,
  updated_at: ts,
});
export type Category = z.infer<typeof categorySchema>;

export const DRAFT_STATUSES = ["ok", "needs_review", "duplicate", "near_duplicate", "error"] as const;

export const draftItemSchema = itemFieldsSchema.extend({
  draft_id: id,
  status: z.enum(DRAFT_STATUSES),
  issues: z.array(z.string().max(500)).default([]),
  /** Original text of this question as cut from the file (shown next to the structured fields). */
  raw: z.string().max(40_000).default(""),
  duplicate_of: id.optional(),
  include: z.boolean().default(true),
});
export type DraftItem = z.infer<typeof draftItemSchema>;

export const IMPORT_FORMATS = ["json", "jsonl", "csv", "xlsx", "markdown", "text", "pdf"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

export const importBatchSchema = z.object({
  id,
  bank_id: id,
  file_name: z.string().max(300),
  format: z.enum(IMPORT_FORMATS),
  status: z.enum(["draft", "committed", "discarded"]),
  /** The user confirmed they have the right to use these questions. */
  rights_confirmed: z.boolean().default(false),
  /** CSV/Excel column mapping used (column header → field). */
  column_map: z.record(z.string()).optional(),
  drafts: z.array(draftItemSchema),
  /** Asset files saved for this batch (page images, embedded images). */
  assets: z.array(z.string()).default([]),
  report: z
    .object({ total: z.number(), ok: z.number(), needs_review: z.number(), duplicate: z.number(), error: z.number(), committed: z.number().optional() })
    .optional(),
  created_at: ts,
  updated_at: ts,
});
export type ImportBatch = z.infer<typeof importBatchSchema>;

export const checkSchema = z.object({ ok: z.boolean(), detail: z.string().max(1000), skipped: z.boolean().optional() });
export type Check = z.infer<typeof checkSchema>;

export const candidateSchema = z.object({
  id,
  stem: z.string().min(1),
  type: z.enum(QUESTION_TYPES),
  options: z.array(z.string()).optional(),
  answer: z.string(),
  solution: z.string().optional(),
  hints: z.array(z.string()).default([]),
  grade: z.string().optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  knowledge_points: z.array(z.string()).default([]),
  checks: z.object({ format: checkSchema, answer: checkSchema, novelty: checkSchema, fit: checkSchema }),
  /** All checks passed (skipped checks do not fail it). */
  passed: z.boolean(),
  adopted_item_id: id.optional(),
});
export type Candidate = z.infer<typeof candidateSchema>;

export const templateRefSchema = z.object({
  category_id: id.optional(),
  item_ids: z.array(id).max(10).optional(),
  style: styleTemplateSchema.optional(),
});
export type TemplateRef = z.infer<typeof templateRefSchema>;

export const generationSchema = z.object({
  id,
  bank_id: id,
  template: templateRefSchema,
  template_label: z.string().max(200),
  mode: z.enum(["same_type"]),
  requested: z.number().int(),
  candidates: z.array(candidateSchema),
  created_at: ts,
});
export type Generation = z.infer<typeof generationSchema>;
