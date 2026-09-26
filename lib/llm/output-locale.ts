/**
 * Language of model-written text (problems, solutions, explanations,
 * method descriptions …), matching the language of the UI.
 *
 * The browser keeps a `ui_locale` cookie with the language on screen
 * (lib/i18n/index.tsx); every API route runs inside Next's request scope,
 * so the cookie is read here at call time — no route has to pass it
 * along. Outside a request (scripts, tests, benchmarks) the default is
 * Chinese, unless `withOutputLocale` sets one explicitly.
 *
 * Prompts were written for Chinese output ("Write Chinese for …", Chinese
 * system prompts). For English, the language words in the prompt are
 * switched and a final instruction states the output language; JSON keys,
 * enum values, Lean code and LaTeX stay as they are.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { isLocale, LOCALE_COOKIE, matchLocale, parseAcceptLanguage, type Locale } from "../i18n/config";

export const UI_LOCALE_COOKIE = "ui_locale";

const forced = new AsyncLocalStorage<Locale>();

/** Run `fn` with a fixed output language (overrides the request's). */
export function withOutputLocale<T>(locale: Locale, fn: () => T): T {
  return forced.run(locale, fn);
}

/** Output language for the current request: explicit scope → UI cookie → manual choice → Accept-Language → zh-CN. */
export async function outputLocale(): Promise<Locale> {
  const f = forced.getStore();
  if (f) return f;
  try {
    const { cookies, headers } = await import("next/headers");
    const jar = await cookies();
    const ui = jar.get(UI_LOCALE_COOKIE)?.value;
    if (isLocale(ui)) return ui;
    const manual = jar.get(LOCALE_COOKIE)?.value;
    if (isLocale(manual)) return manual;
    const accept = (await headers()).get("accept-language");
    return accept ? matchLocale(parseAcceptLanguage(accept)) : "zh-CN";
  } catch {
    // Not inside a request (CLI, tests).
    return "zh-CN";
  }
}

const EN_DIRECTIVE = `OUTPUT LANGUAGE: English. The user reads this in an English interface. Write every natural-language text value you produce (problem statements, answers, hints, explanations, titles, summaries, pros/cons, warnings, labels) in English, even where earlier instructions say Chinese or are themselves written in Chinese. If the problem itself is written in Chinese, still answer in English (translate names and quantities faithfully). Keep JSON keys, enum/identifier values, Lean code and LaTeX math exactly as specified.`;

/** Switch "Chinese" language directives to English (not "Chinese Remainder Theorem"). */
export function englishDirectives(text: string): string {
  return text
    .replace(/\bChinese(?!\s+Remainder)\b/g, "English")
    .replace(/用中文|使用中文|中文(?=写|撰写|作答|回答|输出|表述|说明)/g, "用英文");
}

/** Messages adjusted for the output language (unchanged for Chinese). */
export function localizeMessages<M extends { role: string; content: string }>(messages: M[], locale: Locale, opts: { minimal?: boolean } = {}): M[] {
  if (locale !== "en-US") return messages;
  const out = messages.map((m) => (m.role === "assistant" ? m : { ...m, content: englishDirectives(m.content) }));
  // Lean-writing calls (prover role): only switch the language words, add nothing to the prompt.
  if (opts.minimal) return out;
  const sysIdx = out.findIndex((m) => m.role === "system");
  if (sysIdx >= 0) out[sysIdx] = { ...out[sysIdx], content: `${out[sysIdx].content}\n\n${EN_DIRECTIVE}` };
  else out.unshift({ role: "system", content: EN_DIRECTIVE } as M);
  // Also remind at the end of the last user turn, where it weighs most.
  const lastUser = out.findLastIndex((m) => m.role === "user");
  if (lastUser >= 0) out[lastUser] = { ...out[lastUser], content: `${out[lastUser].content}\n\n(Answer in English.)` };
  return out;
}

/**
 * Pick the Chinese or English text for server-produced messages (progress
 * events, summaries, check details, error messages). Synchronous: uses the
 * language fixed by `withRequestLocale` / `withOutputLocale`; Chinese outside one.
 */
export function lt(zh: string, en: string): string {
  return forced.getStore() === "en-US" ? en : zh;
}

/** True when server messages should be English (see `lt`). */
export function isEnglish(): boolean {
  return forced.getStore() === "en-US";
}

/**
 * Wrap a route handler so everything it does — including work continued in
 * a streamed response — runs with the request's UI language fixed.
 * Usage: `export const POST = withRequestLocale(handlePost);`
 */
export function withRequestLocale<A extends unknown[], R>(handler: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const locale = await outputLocale();
    return forced.run(locale, () => handler(...args));
  };
}
