"use client";

import { useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import { FileDown, Printer } from "lucide-react";
import { MathText } from "../components/MathText";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Candidate, Generation } from "@/lib/bank/types";
import { answerText, fromCandidates, loadStashedWorksheet, optionColumns, type Worksheet, type WorksheetQuestion } from "@/lib/bank/worksheet";

type Scope = "passed" | "all" | "picked";
type Answers = "end" | "inline" | "none";

/**
 * Printable worksheet of generated questions, or the worked solution of one problem (kind "solution"):
 * the browser's print dialog saves it as a PDF ("Save as PDF"), so maths (KaTeX), Chinese text and
 * figures come out exactly as on screen. Question sheets print without answers unless chosen.
 */
export default function PrintPage() {
  const { tr } = useI18n();
  const [questions, setQuestions] = useState<WorksheetQuestion[] | null>(null);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState<Scope>("passed");
  const [answers, setAnswers] = useState<Answers>("none");
  const [kind, setKind] = useState<NonNullable<Worksheet["kind"]>>("questions");
  const [showVerification, setShowVerification] = useState(false);
  const [showSolutionFigure, setShowSolutionFigure] = useState(true);
  const [solutions, setSolutions] = useState(false);
  const [onePerPage, setOnePerPage] = useState(false);
  const [nameLine, setNameLine] = useState(true);

  useEffect(() => {
    const url = new URL(window.location.href);
    const key = url.searchParams.get("key");
    const bank = url.searchParams.get("bank");
    const gen = url.searchParams.get("gen");
    const ids = url.searchParams.get("ids")?.split(",").filter(Boolean) ?? null;
    if (key) {
      const ws = loadStashedWorksheet(key);
      queueMicrotask(() => {
        if (!ws) setError(tr("找不到要打印的题目（请回到出题页面重新点“导出 PDF”）", "The questions to print were not found (go back and click “Export PDF” again)"));
        else {
          setQuestions(ws.questions);
          setTitle(ws.title);
          setScope("all");
          setKind(ws.kind ?? "questions");
        }
      });
      return;
    }
    if (!bank || !gen) {
      queueMicrotask(() => setError(tr("链接不完整", "The link is incomplete")));
      return;
    }
    fetch(`/api/banks/${encodeURIComponent(bank)}/generations/${encodeURIComponent(gen)}`)
      .then(async (r) => {
        const d = (await r.json()) as { generation?: Generation; error?: string };
        if (!r.ok || !d.generation) throw new Error(d.error ?? `HTTP ${r.status}`);
        setQuestions(fromCandidates(d.generation.candidates as Candidate[]));
        setTitle(d.generation.template_label || tr("练习题", "Practice questions"));
        if (ids?.length) {
          setPicked(ids);
          setScope("picked");
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [tr]);

  // The PDF's file name is the page title.
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);

  const shown = useMemo(() => {
    if (!questions) return [];
    if (scope === "picked" && picked) return questions.filter((q) => picked.includes(q.id));
    if (scope === "passed") return questions.filter((q) => q.passed !== false);
    return questions;
  }, [questions, scope, picked]);

  const hasPassInfo = !!questions?.some((q) => q.passed !== undefined);
  const hasSolutionFigure = !!questions?.some((q) => q.solutionFigureSvg);
  const hasVerification = !!questions?.some((q) => q.verification);

  return (
    <div className="worksheet-root min-h-screen bg-neutral-200 text-neutral-900 print:bg-white">
      <style>{`
        @page { size: A4; margin: 16mm 15mm; }
        @media print {
          html, body { background: #fff !important; }
          .math-bg::before { display: none !important; }
          .no-print { display: none !important; }
          .sheet { box-shadow: none !important; margin: 0 !important; padding: 0 !important; width: auto !important; min-height: 0 !important; }
        }
        .worksheet-root .katex { color: inherit; }
        .q-block { break-inside: avoid; page-break-inside: avoid; }
        .page-break { break-before: page; page-break-before: always; }
      `}</style>

      {/* Toolbar (not printed) */}
      <div className="no-print sticky top-0 z-10 border-b border-neutral-300 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-[210mm] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="min-w-[14rem] flex-1 rounded border border-neutral-300 px-2 py-1 font-semibold"
            aria-label={tr("标题", "Title")}
            placeholder={tr("标题", "Title")}
          />
          <button
            type="button"
            onClick={() => window.print()}
            disabled={!shown.length}
            className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
            data-testid="print-button"
          >
            <Printer className="h-4 w-4" />
            {tr("打印 / 保存为 PDF", "Print / Save as PDF")}
          </button>
          <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 text-xs text-neutral-700">
            {kind === "solution" ? (
              <>
                {hasSolutionFigure && (
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={showSolutionFigure} onChange={(e) => setShowSolutionFigure(e.target.checked)} />
                    {tr("含解题图形", "With the solution figure")}
                  </label>
                )}
                {hasVerification && (
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={showVerification} onChange={(e) => setShowVerification(e.target.checked)} />
                    {tr("含验证", "With the check")}
                  </label>
                )}
              </>
            ) : (
            <>
            <label className="flex items-center gap-1.5">
              {tr("题目", "Questions")}
              <select value={scope} onChange={(e) => setScope(e.target.value as Scope)} className="rounded border border-neutral-300 px-1.5 py-0.5">
                {picked && <option value="picked">{tr(`选中的 ${picked.length} 道`, `${picked.length} picked`)}</option>}
                {hasPassInfo && <option value="passed">{tr("通过检查的", "Passed the checks")}</option>}
                <option value="all">{tr("全部", "All")}</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              {tr("答案", "Answers")}
              <select value={answers} onChange={(e) => setAnswers(e.target.value as Answers)} className="rounded border border-neutral-300 px-1.5 py-0.5">
                <option value="end">{tr("单独一页（答案页）", "On a separate answer page")}</option>
                <option value="inline">{tr("紧跟每道题", "After each question")}</option>
                <option value="none">{tr("不含答案", "No answers")}</option>
              </select>
            </label>
            <label className={cn("flex items-center gap-1.5", answers === "none" && "opacity-40")}>
              <input type="checkbox" checked={solutions} disabled={answers === "none"} onChange={(e) => setSolutions(e.target.checked)} />
              {tr("含解析", "With worked solutions")}
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={onePerPage} onChange={(e) => setOnePerPage(e.target.checked)} />
              {tr("每题一页", "One question per page")}
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={nameLine} onChange={(e) => setNameLine(e.target.checked)} />
              {tr("姓名 / 日期栏", "Name / date line")}
            </label>
            </>
            )}
            <span className="ml-auto flex items-center gap-1 text-neutral-500">
              <FileDown className="h-3.5 w-3.5" />
              {tr("在打印窗口选择“另存为 PDF”", "Choose “Save as PDF” in the print window")}
            </span>
          </div>
        </div>
      </div>

      {/* The paper */}
      <div className="sheet mx-auto my-6 min-h-[297mm] w-[210mm] max-w-full bg-white px-[15mm] py-[16mm] shadow-lg" data-testid="worksheet">
        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : !questions ? (
          <p className="text-sm text-neutral-500">{tr("加载中…", "Loading…")}</p>
        ) : kind === "solution" ? (
          <>
            <header className="mb-6 border-b-2 border-neutral-800 pb-3">
              <h1 className="text-xl font-bold">{title}</h1>
            </header>
            {questions.map((q) => (
              <SolutionBlock key={q.id} q={q} figure={showSolutionFigure} verification={showVerification} />
            ))}
          </>
        ) : (
          <>
            <header className="mb-6 border-b-2 border-neutral-800 pb-3">
              <h1 className="text-xl font-bold">{title}</h1>
              {nameLine && (
                <div className="mt-3 flex gap-8 text-sm">
                  <span>{tr("姓名：", "Name: ")}<span className="inline-block w-40 border-b border-neutral-500" /></span>
                  <span>{tr("日期：", "Date: ")}<span className="inline-block w-28 border-b border-neutral-500" /></span>
                  <span>{tr("得分：", "Score: ")}<span className="inline-block w-16 border-b border-neutral-500" />{` / ${shown.length}`}</span>
                </div>
              )}
            </header>
            {shown.length === 0 && <p className="text-sm text-neutral-500">{tr("没有要打印的题目", "No questions to print")}</p>}
            <ol className="space-y-7">
              {shown.map((q, i) => (
                <li key={q.id} className={cn("q-block", onePerPage && i > 0 && "page-break")} data-testid="worksheet-question">
                  <QuestionBlock q={q} n={i + 1} answer={answers === "inline"} solution={answers === "inline" && solutions} />
                </li>
              ))}
            </ol>
            {answers === "end" && shown.length > 0 && (
              <section className="page-break pt-2" data-testid="answer-page">
                <h2 className="mb-4 border-b-2 border-neutral-800 pb-2 text-lg font-bold">{tr("答案", "Answers")}</h2>
                <ol className="space-y-3 text-sm">
                  {shown.map((q, i) => (
                    <li key={q.id} className="q-block flex gap-2">
                      <span className="w-7 shrink-0 font-semibold">{i + 1}.</span>
                      <div className="min-w-0 flex-1">
                        <MathText text={answerText(q)} />
                        {solutions && q.solution && (
                          <div className="mt-1 whitespace-pre-line text-neutral-600">
                            <MathText text={q.solution} />
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function QuestionBlock({ q, n, answer, solution, bare = false }: { q: WorksheetQuestion; n: number; answer: boolean; solution: boolean; bare?: boolean }) {
  const { tr } = useI18n();
  const svg = useMemo(() => {
    if (!q.figureSvg || typeof window === "undefined" || !DOMPurify.isSupported) return "";
    return DOMPurify.sanitize(q.figureSvg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["foreignObject", "script", "style"] });
  }, [q.figureSvg]);
  const cols = q.options?.length ? optionColumns(q.options) : 1;
  return (
    <div className="flex gap-2 text-[15px] leading-relaxed">
      {!bare && <span className="w-7 shrink-0 font-semibold">{n}.</span>}
      <div className="min-w-0 flex-1 space-y-2.5">
        <div className="whitespace-pre-line">
          <MathText text={q.stem} />
        </div>
        {svg && <div className="[&_svg]:h-auto [&_svg]:max-h-[90mm] [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />}
        {q.figureImages?.filter((u) => /^(\/|blob:)/.test(u)).map((u, k) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={k} src={u} alt="" className="max-h-[90mm] max-w-full" />
        ))}
        {q.options?.length ? (
          <ol className={cn("grid gap-x-6 gap-y-1", cols === 4 ? "grid-cols-4" : cols === 2 ? "grid-cols-2" : "grid-cols-1")}>
            {q.options.map((o, k) => (
              <li key={k} className="flex gap-1.5">
                <span className="font-semibold">{String.fromCharCode(65 + k)}.</span>
                <MathText text={o} />
              </li>
            ))}
          </ol>
        ) : (
          !answer && !bare && <div className="pt-6"><span className="inline-block w-48 border-b border-neutral-500" /></div>
        )}
        {answer && (
          <div className="rounded border border-neutral-300 bg-neutral-50 px-2.5 py-1.5 text-sm">
            <span className="font-semibold">{tr("答案：", "Answer: ")}</span>
            <MathText text={answerText(q)} />
            {solution && q.solution && (
              <div className="mt-1 whitespace-pre-line text-neutral-600">
                <MathText text={q.solution} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The worked solution of one problem: the problem, the steps, then the answer at the end. */
function SolutionBlock({ q, figure, verification }: { q: WorksheetQuestion; figure: boolean; verification: boolean }) {
  const { tr } = useI18n();
  const solutionSvg = useMemo(() => {
    if (!q.solutionFigureSvg || typeof window === "undefined" || !DOMPurify.isSupported) return "";
    return DOMPurify.sanitize(q.solutionFigureSvg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["foreignObject", "script", "style"] });
  }, [q.solutionFigureSvg]);
  return (
    <div className="space-y-6 text-[15px] leading-relaxed" data-testid="solution-sheet">
      <section className="q-block">
        <h2 className="mb-2 text-sm font-bold text-neutral-600">{tr("题目", "Problem")}</h2>
        <QuestionBlock q={q} n={0} answer={false} solution={false} bare />
      </section>
      {figure && solutionSvg && (
        <section className="q-block">
          <h2 className="mb-2 text-sm font-bold text-neutral-600">{tr("解题图形", "Solution figure")}</h2>
          {/* The figure is drawn for the app's dark theme: printed on its dark panel (colours kept when printing). */}
          <div
            className="flex justify-center rounded-md bg-slate-900 p-3 [print-color-adjust:exact] [-webkit-print-color-adjust:exact] [&_svg]:h-auto [&_svg]:max-h-[95mm] [&_svg]:max-w-full"
            dangerouslySetInnerHTML={{ __html: solutionSvg }}
          />
        </section>
      )}
      {q.steps?.length ? (
        <section>
          <h2 className="mb-3 border-b border-neutral-400 pb-1 text-base font-bold">{tr("解题过程", "Solution")}</h2>
          <ol className="space-y-4">
            {q.steps.map((s, i) => (
              <li key={i} className="q-block flex gap-2" data-testid="solution-step">
                <span className="w-7 shrink-0 font-semibold">{i + 1}.</span>
                <div className="min-w-0 flex-1 space-y-1.5">
                  {s.title && <div className="font-semibold">{s.title}</div>}
                  <div className="whitespace-pre-line">
                    <MathText text={s.content} />
                  </div>
                  {s.substeps?.length ? (
                    <ul className="list-disc space-y-0.5 pl-5 text-neutral-700">
                      {s.substeps.map((t, k) => (
                        <li key={k}>
                          <MathText text={t} />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {s.key_formula && (
                    <div className="rounded border border-neutral-300 bg-neutral-50 px-3 py-1.5 text-center">
                      <MathText text={/\$/.test(s.key_formula) ? s.key_formula : `$${s.key_formula}$`} />
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : q.solution ? (
        <section>
          <h2 className="mb-3 border-b border-neutral-400 pb-1 text-base font-bold">{tr("解题过程", "Solution")}</h2>
          <div className="whitespace-pre-line">
            <MathText text={q.solution} />
          </div>
        </section>
      ) : null}
      {verification && q.verification && (
        <section className="q-block text-sm text-neutral-700">
          <span className="font-semibold">{tr("验证：", "Check: ")}</span>
          <MathText text={q.verification} />
        </section>
      )}
      <section className="q-block rounded-md border-2 border-neutral-800 px-4 py-3" data-testid="solution-answer">
        <span className="font-bold">{tr("答案：", "Answer: ")}</span>
        <MathText text={answerText(q)} />
      </section>
    </div>
  );
}
