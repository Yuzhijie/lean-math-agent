/**
 * Storage for marking: classes, roster members and submissions as JSON documents in one SQLite
 * file (better-sqlite3), with the photos beside it.
 *
 *   <root>/grading.sqlite          documents (kind, id) → JSON
 *   <root>/grading.jsonl           the same, when SQLite is unavailable
 *   <root>/assets/<submission>/    the photos of a submission
 *
 * <root> is GRADING_STORE_PATH (default .data/grading). Access rules live here too:
 * a class belongs to the teacher who made it; a student sees the submissions of the roster
 * entries linked to their account.
 */
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BankError } from "../bank/store";
import { lt } from "../llm/output-locale";
import { z } from "zod";
import { classSchema, diagnosisSchema, memberSchema, paperSchema, submissionSchema, type Diagnosis, type GradingClass, type Member, type Paper, type Submission } from "./types";

/** A student's latest diagnosis over all their marked work (id = the member id). */
const memberDiagnosisSchema = z.object({ id: z.string(), diagnosis: diagnosisSchema });
type MemberDiagnosis = z.infer<typeof memberDiagnosisSchema>;

export { BankError as GradingError };

type Kind = "class" | "member" | "submission" | "paper" | "diagnosis";
const SCHEMAS = { class: classSchema, member: memberSchema, submission: submissionSchema, paper: paperSchema, diagnosis: memberDiagnosisSchema };
type Docs = { class: GradingClass; member: Member; submission: Submission; paper: Paper; diagnosis: MemberDiagnosis };

export function gradingRoot(): string {
  return process.env.GRADING_STORE_PATH ?? path.join(".data", "grading");
}

interface Backend {
  all(): { kind: Kind; data: unknown }[];
  put(kind: Kind, id: string, doc: unknown): void;
  remove(kind: Kind, id: string): void;
}

type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): Array<{ kind: Kind; data: string }> };
};

function open(root: string): Backend {
  fs.mkdirSync(root, { recursive: true });
  if (process.env.GRADING_STORE_BACKEND !== "jsonl") {
    try {
      const Database = require("better-sqlite3") as new (file: string) => SqliteDb;
      const db = new Database(path.join(root, "grading.sqlite"));
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("CREATE TABLE IF NOT EXISTS docs (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (kind, id))");
      const sel = db.prepare("SELECT kind, data FROM docs");
      const up = db.prepare("INSERT OR REPLACE INTO docs (kind, id, data, updated_at) VALUES (?, ?, ?, ?)");
      const del = db.prepare("DELETE FROM docs WHERE kind = ? AND id = ?");
      return {
        all: () => sel.all().map((r) => ({ kind: r.kind, data: JSON.parse(r.data) })),
        put: (kind, id, doc) => void up.run(kind, id, JSON.stringify(doc), Date.now()),
        remove: (kind, id) => void del.run(kind, id),
      };
    } catch {
      // fall through to JSONL
    }
  }
  const file = path.join(root, "grading.jsonl");
  const rows = new Map<string, { kind: Kind; data: unknown }>();
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { kind: Kind; id: string; data?: unknown; deleted?: boolean };
        if (r.deleted) rows.delete(`${r.kind}:${r.id}`);
        else rows.set(`${r.kind}:${r.id}`, { kind: r.kind, data: r.data });
      } catch {
        /* torn line */
      }
    }
  }
  return {
    all: () => [...rows.values()],
    put: (kind, id, data) => {
      rows.set(`${kind}:${id}`, { kind, data });
      fs.appendFileSync(file, JSON.stringify({ kind, id, data }) + "\n");
    },
    remove: (kind, id) => {
      rows.delete(`${kind}:${id}`);
      fs.appendFileSync(file, JSON.stringify({ kind, id, deleted: true }) + "\n");
    },
  };
}

interface Store {
  root: string;
  backend: Backend;
  docs: { [K in Kind]: Map<string, Docs[K]> };
}

let store: Store | undefined;

function db(): Store {
  const root = gradingRoot();
  if (store?.root === root) return store;
  const backend = open(root);
  const docs = { class: new Map(), member: new Map(), submission: new Map(), paper: new Map(), diagnosis: new Map() } as Store["docs"];
  for (const r of backend.all()) {
    const parsed = SCHEMAS[r.kind]?.safeParse(r.data);
    if (parsed?.success) (docs[r.kind] as Map<string, unknown>).set((parsed.data as { id: string }).id, parsed.data);
  }
  store = { root, backend, docs };
  return store;
}

/** For tests: forget the open store (a new GRADING_STORE_PATH is read on next use). */
export function _resetGradingStore(): void {
  store = undefined;
}

function put<K extends Kind>(kind: K, doc: Docs[K]): Docs[K] {
  const s = db();
  const v = SCHEMAS[kind].parse(doc) as Docs[K];
  (s.docs[kind] as Map<string, Docs[K]>).set((v as { id: string }).id, v);
  s.backend.put(kind, (v as { id: string }).id, v);
  return v;
}

function remove(kind: Kind, id: string): void {
  const s = db();
  s.docs[kind].delete(id);
  s.backend.remove(kind, id);
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const WHAT: Record<string, [string, string]> = {
  class: ["老师", "teacher"],
  student: ["学生", "student"],
  submission: ["作答", "submission"],
  image: ["照片", "photo"],
};
const notFound = (what: string) => new BankError(lt(`找不到这个${WHAT[what]?.[0] ?? what}`, `${WHAT[what]?.[1] ?? what} not found`), 404);

// ── Classes ──────────────────────────────────────────────────────────

/** Join code: 6 characters without look-alikes (0/O, 1/I/L). */
export function newJoinCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const taken = new Set([...db().docs.class.values()].map((c) => c.join_code));
  for (;;) {
    const bytes = randomBytes(6);
    const code = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
    if (!taken.has(code)) return code;
  }
}

export function createClass(owner: string, name: string): GradingClass {
  return put("class", { id: randomUUID().slice(0, 12), owner, name: name.trim().slice(0, 100), join_code: newJoinCode(), created_at: Date.now() });
}

export function classesTaughtBy(owner: string): GradingClass[] {
  return [...db().docs.class.values()].filter((c) => c.owner === owner).sort((a, b) => a.created_at - b.created_at);
}

export function getClass(id: string): GradingClass {
  if (!SAFE_ID.test(id)) throw notFound("class");
  const c = db().docs.class.get(id);
  if (!c) throw notFound("class");
  return c;
}

/** The class, if the caller teaches it (else 404, so other teachers' classes are not revealed). */
export function teacherClass(owner: string, id: string): GradingClass {
  const c = getClass(id);
  if (c.owner !== owner) throw notFound("class");
  return c;
}

export function renameClass(owner: string, id: string, name: string): GradingClass {
  return put("class", { ...teacherClass(owner, id), name: name.trim().slice(0, 100) });
}

export function regenerateJoinCode(owner: string, id: string): GradingClass {
  return put("class", { ...teacherClass(owner, id), join_code: newJoinCode() });
}

/** Deletes the class with its roster, submissions and photos. */
export function deleteClass(owner: string, id: string): void {
  teacherClass(owner, id);
  for (const p of [...db().docs.paper.values()].filter((x) => x.class_id === id)) deletePaperDoc(p);
  for (const s of [...db().docs.submission.values()].filter((x) => x.class_id === id)) deleteSubmissionDoc(s);
  for (const m of [...db().docs.member.values()].filter((x) => x.class_id === id)) {
    if (db().docs.diagnosis.has(m.id)) remove("diagnosis", m.id);
    remove("member", m.id);
  }
  remove("class", id);
}

// ── A teacher's students (one group per teacher; there is no class level in the UI) ──

/**
 * The teacher's student group, if any. Data from when teachers could keep several classes is
 * folded into the oldest one the first time it is read: rosters and work move over, the other
 * classes (and their join codes) go away.
 */
export function teacherGroup(owner: string): GradingClass | undefined {
  const all = classesTaughtBy(owner);
  if (all.length <= 1) return all[0];
  const [keep, ...rest] = all;
  const d = db();
  for (const old of rest) {
    for (const m of [...d.docs.member.values()].filter((x) => x.class_id === old.id)) put("member", { ...m, class_id: keep.id });
    for (const sub of [...d.docs.submission.values()].filter((x) => x.class_id === old.id)) put("submission", { ...sub, class_id: keep.id });
    for (const p of [...d.docs.paper.values()].filter((x) => x.class_id === old.id)) put("paper", { ...p, class_id: keep.id });
    remove("class", old.id);
  }
  return keep;
}

/** The teacher's group, created on first use (`name` is how students see the teacher). */
export function ensureTeacherGroup(owner: string, name: string): GradingClass {
  return teacherGroup(owner) ?? createClass(owner, name);
}

export function classByCode(code: string): GradingClass | undefined {
  const c = code.trim().toUpperCase();
  return [...db().docs.class.values()].find((x) => x.join_code === c);
}

// ── Roster ───────────────────────────────────────────────────────────

export function membersOf(classId: string): Member[] {
  return [...db().docs.member.values()].filter((m) => m.class_id === classId).sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

export function addMember(owner: string, classId: string, name: string): Member {
  teacherClass(owner, classId);
  const n = name.trim().slice(0, 60);
  if (!n) throw new BankError(lt("请填写姓名", "Enter a name"), 400);
  return put("member", { id: randomUUID().slice(0, 12), class_id: classId, name: n, created_at: Date.now() });
}

export function getMember(id: string): Member {
  if (!SAFE_ID.test(id)) throw notFound("student");
  const m = db().docs.member.get(id);
  if (!m) throw notFound("student");
  return m;
}

export function renameMember(owner: string, memberId: string, name: string): Member {
  const m = getMember(memberId);
  teacherClass(owner, m.class_id);
  return put("member", { ...m, name: name.trim().slice(0, 60) });
}

/** The teacher unlinks the account from a roster name (e.g. the wrong student claimed it). */
export function unlinkMember(owner: string, memberId: string): Member {
  const m = getMember(memberId);
  teacherClass(owner, m.class_id);
  const { user_id: _u, ...rest } = m;
  void _u;
  return put("member", rest);
}

/** Removes the roster entry with all of the student's work in this class. */
export function removeMember(owner: string, memberId: string): void {
  const m = getMember(memberId);
  teacherClass(owner, m.class_id);
  for (const s of [...db().docs.submission.values()].filter((x) => x.member_id === memberId)) deleteSubmissionDoc(s);
  for (const p of [...db().docs.paper.values()].filter((x) => x.member_id === memberId)) deletePaperDoc(p);
  if (db().docs.diagnosis.has(memberId)) remove("diagnosis", memberId);
  remove("member", memberId);
}

/**
 * A student joins with the class code: links an existing roster name that has no account yet
 * (`memberId`), or adds a new entry under `name`. One entry per account per class.
 */
export function joinClass(userId: string, code: string, opts: { memberId?: string; name?: string }): { cls: GradingClass; member: Member } {
  const cls = classByCode(code);
  if (!cls) throw new BankError(lt("没有这个邀请码", "No teacher has this invite code"), 404);
  const mine = membersOf(cls.id).find((m) => m.user_id === userId);
  if (mine) return { cls, member: mine };
  if (opts.memberId) {
    const m = getMember(opts.memberId);
    if (m.class_id !== cls.id) throw notFound("student");
    if (m.user_id && m.user_id !== userId) throw new BankError(lt("这个名字已经被另一个账号认领了，请找老师确认", "This name is already linked to another account; ask your teacher"), 409);
    return { cls, member: put("member", { ...m, user_id: userId }) };
  }
  const name = opts.name?.trim().slice(0, 60);
  if (!name) throw new BankError(lt("请填写姓名", "Enter a name"), 400);
  return { cls, member: put("member", { id: randomUUID().slice(0, 12), class_id: cls.id, name, user_id: userId, created_at: Date.now() }) };
}

/** The roster entries linked to an account, with their classes. */
export function enrolments(userId: string): { cls: GradingClass; member: Member }[] {
  const out: { cls: GradingClass; member: Member }[] = [];
  for (const m of db().docs.member.values()) {
    if (m.user_id !== userId) continue;
    const cls = db().docs.class.get(m.class_id);
    if (cls) out.push({ cls, member: m });
  }
  return out;
}

// ── Access ───────────────────────────────────────────────────────────

/** Who the caller is to this roster entry: its teacher, the student themself, or nobody (404). */
export function accessToMember(userId: string, memberId: string): { role: "teacher" | "student"; member: Member; cls: GradingClass } {
  const member = getMember(memberId);
  const cls = getClass(member.class_id);
  if (cls.owner === userId) return { role: "teacher", member, cls };
  if (member.user_id === userId) return { role: "student", member, cls };
  throw notFound("student");
}

// ── Submissions ──────────────────────────────────────────────────────

function assetDir(submissionId: string): string {
  return path.join(gradingRoot(), "assets", submissionId);
}

export function newSubmissionId(): string {
  return randomUUID().slice(0, 16).replace(/-/g, "");
}

/** Saves the photos of a submission; returns their file names. */
export function saveSubmissionImages(submissionId: string, images: { data: Buffer; ext: string }[]): string[] {
  if (!SAFE_ID.test(submissionId)) throw notFound("submission");
  const dir = assetDir(submissionId);
  fs.mkdirSync(dir, { recursive: true });
  return images.map((img, i) => {
    const name = `${i + 1}.${img.ext.replace(/[^a-z0-9]/gi, "") || "jpg"}`;
    fs.writeFileSync(path.join(dir, name), img.data);
    return name;
  });
}

export function putSubmission(s: Submission): Submission {
  return put("submission", s);
}

export function getSubmission(id: string): Submission {
  if (!SAFE_ID.test(id)) throw notFound("submission");
  const s = db().docs.submission.get(id);
  if (!s) throw notFound("submission");
  return s;
}

/** The submission if the caller teaches its class or is its student. */
export function visibleSubmission(userId: string, id: string): { submission: Submission; role: "teacher" | "student" } {
  const submission = getSubmission(id);
  const { role } = accessToMember(userId, submission.member_id);
  return { submission, role };
}

export function readSubmissionImage(userId: string, id: string, name: string): Buffer {
  const { submission } = visibleSubmission(userId, id);
  if (!submission.images.includes(name)) throw notFound("image");
  return fs.readFileSync(path.join(assetDir(id), name));
}

export function submissionsOf(memberId: string): Submission[] {
  return [...db().docs.submission.values()].filter((s) => s.member_id === memberId).sort((a, b) => b.created_at - a.created_at);
}

export function submissionsOfClass(classId: string): Submission[] {
  return [...db().docs.submission.values()].filter((s) => s.class_id === classId).sort((a, b) => b.created_at - a.created_at);
}

function deleteSubmissionDoc(s: Submission): void {
  fs.rmSync(assetDir(s.id), { recursive: true, force: true });
  remove("submission", s.id);
}

/** Teachers may delete any work in their class; students only work they uploaded themselves. */
export function deleteSubmission(userId: string, id: string): void {
  const { submission, role } = visibleSubmission(userId, id);
  if (role === "student" && submission.submitted_by !== userId) {
    throw new BankError(lt("老师上传的作答只能由老师删除", "Work your teacher uploaded can only be deleted by the teacher"), 403);
  }
  deleteSubmissionDoc(submission);
  if (submission.paper_id) refreshPaper(submission.paper_id);
}

/**
 * Stores the result of a (long) marking run on top of the submission as it is NOW: a teacher's
 * verdict or note made meanwhile is kept, and nothing is written when the submission, its student
 * or its class was deleted in the meantime (its photos are removed then). Returns the stored record.
 */
export function saveMarkingResult(
  draft: Submission,
  result: Partial<Pick<Submission, "reading" | "marking" | "reference" | "status" | "error">>,
  opts: { isNew?: boolean } = {},
): Submission | undefined {
  const d = db();
  const member = d.docs.member.get(draft.member_id);
  if (!member || !d.docs.class.has(draft.class_id)) {
    fs.rmSync(assetDir(draft.id), { recursive: true, force: true });
    d.docs.submission.delete(draft.id);
    return undefined;
  }
  const current = d.docs.submission.get(draft.id) ?? (opts.isNew ? draft : undefined);
  if (!current) return undefined; // deleted while it was being marked again
  const saved = put("submission", { ...current, ...result });
  if (saved.paper_id && !opts.isNew) refreshPaper(saved.paper_id);
  return saved;
}

// ── Papers (答卷) and diagnoses ──────────────────────────────────────

function paperDir(paperId: string): string {
  return path.join(gradingRoot(), "papers", paperId);
}

export function newPaperId(): string {
  return "p" + randomUUID().replace(/-/g, "").slice(0, 15);
}

/** Saves the page photos of a paper; returns their file names. */
export function savePaperImages(paperId: string, images: { data: Buffer; ext: string }[]): string[] {
  if (!SAFE_ID.test(paperId)) throw notFound("submission");
  const dir = paperDir(paperId);
  fs.mkdirSync(dir, { recursive: true });
  return images.map((img, i) => {
    const name = `${i + 1}.${img.ext.replace(/[^a-z0-9]/gi, "") || "jpg"}`;
    fs.writeFileSync(path.join(dir, name), img.data);
    return name;
  });
}

export function putPaper(p: Paper): Paper {
  return put("paper", p);
}

export function getPaper(id: string): Paper {
  if (!SAFE_ID.test(id)) throw notFound("submission");
  const p = db().docs.paper.get(id);
  if (!p) throw notFound("submission");
  return p;
}

/** The paper if the caller teaches the student or is the student. */
export function visiblePaper(userId: string, id: string): { paper: Paper; role: "teacher" | "student" } {
  const paper = getPaper(id);
  const { role } = accessToMember(userId, paper.member_id);
  return { paper, role };
}

export function readPaperImage(userId: string, id: string, name: string): Buffer {
  const { paper } = visiblePaper(userId, id);
  if (!paper.images.includes(name)) throw notFound("image");
  return fs.readFileSync(path.join(paperDir(id), name));
}

export function papersOf(memberId: string): Paper[] {
  return [...db().docs.paper.values()].filter((p) => p.member_id === memberId).sort((a, b) => b.created_at - a.created_at);
}

function deletePaperDoc(p: Paper): void {
  for (const id of p.submission_ids) {
    const s = db().docs.submission.get(id);
    if (s) deleteSubmissionDoc(s);
  }
  fs.rmSync(paperDir(p.id), { recursive: true, force: true });
  remove("paper", p.id);
}

/** Teachers may delete any paper of their students; students only papers they uploaded. */
export function deletePaper(userId: string, id: string): void {
  const { paper, role } = visiblePaper(userId, id);
  if (role === "student" && paper.submitted_by !== userId) {
    throw new BankError(lt("老师上传的答卷只能由老师删除", "A paper your teacher uploaded can only be deleted by the teacher"), 403);
  }
  deletePaperDoc(paper);
}

/** Writes a paper's (long) marking result unless the paper or its student was removed meanwhile. */
export function savePaperResult(paper: Paper, opts: { isNew?: boolean } = {}): Paper | undefined {
  const d = db();
  if (!d.docs.member.has(paper.member_id) || !d.docs.class.has(paper.class_id) || (!opts.isNew && !d.docs.paper.has(paper.id))) {
    for (const id of paper.submission_ids) {
      const s = d.docs.submission.get(id);
      if (s) deleteSubmissionDoc(s);
    }
    fs.rmSync(paperDir(paper.id), { recursive: true, force: true });
    return undefined;
  }
  return put("paper", paper);
}

/**
 * After one of a paper's questions was marked again or deleted: drops questions that are gone and
 * sets the status from the rest (a paper whose questions were all deleted is deleted).
 */
export function refreshPaper(paperId: string): Paper | undefined {
  const d = db();
  const p = d.docs.paper.get(paperId);
  if (!p) return undefined;
  const subs = p.submission_ids.map((id) => d.docs.submission.get(id)).filter((s): s is Submission => !!s);
  if (!subs.length) {
    deletePaperDoc(p);
    return undefined;
  }
  const failed = subs.filter((s) => s.status === "failed").length;
  const status = failed === subs.length ? "failed" : failed ? "partial" : "marked";
  if (status === p.status && subs.length === p.submission_ids.length) return p;
  return put("paper", { ...p, status, submission_ids: subs.map((s) => s.id), ...(status !== "failed" ? { error: undefined } : {}) });
}

/** A paper run that died before its result was stored: its photos go. */
export function discardPaperDraft(paperId: string): void {
  if (!SAFE_ID.test(paperId) || db().docs.paper.has(paperId)) return;
  fs.rmSync(paperDir(paperId), { recursive: true, force: true });
}

export function getMemberDiagnosis(memberId: string): Diagnosis | undefined {
  return db().docs.diagnosis.get(memberId)?.diagnosis;
}

export function putMemberDiagnosis(memberId: string, diagnosis: Diagnosis): Diagnosis | undefined {
  if (!db().docs.member.has(memberId)) return undefined;
  return put("diagnosis", { id: memberId, diagnosis }).diagnosis;
}
