/**
 * Internationalization configuration.
 *
 * Supported locales: zh-CN, en-US. By default the page follows the
 * operating system / browser language (Accept-Language on the server,
 * navigator.languages in the browser); a manual choice from the language
 * switcher is stored in the `locale` cookie and wins until the user picks
 * "follow system" again (which clears the cookie).
 */
export const locales = ['zh-CN', 'en-US'] as const;
export type Locale = (typeof locales)[number];
/** A manual choice, or "system" = follow the OS / browser language. */
export type LocalePref = Locale | 'system';
export const defaultLocale: Locale = 'zh-CN';
export const LOCALE_COOKIE = 'locale';

export const localeNames: Record<Locale, string> = {
  'zh-CN': '简体中文',
  'en-US': 'English',
};

/** Short label for the switcher button. */
export const localeShort: Record<Locale, string> = {
  'zh-CN': '中',
  'en-US': 'EN',
};

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (locales as readonly string[]).includes(v);
}

/**
 * Pick a supported locale from a preference list (navigator.languages, or
 * the tags of an Accept-Language header in order). Chinese of any region or
 * script → zh-CN, English → en-US; the first supported language wins, and a
 * system with neither falls back to English.
 */
export function matchLocale(languages: readonly string[]): Locale {
  for (const raw of languages) {
    const tag = raw.trim().toLowerCase();
    if (tag.startsWith('zh')) return 'zh-CN';
    if (tag.startsWith('en')) return 'en-US';
  }
  return languages.length ? 'en-US' : defaultLocale;
}

/** Language tags of an Accept-Language header, highest quality first. */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag: tag.trim(), q: q ? Number(q.slice(2)) || 0 : 1, i };
    })
    .filter((x) => x.tag && x.tag !== '*' && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i)
    .map((x) => x.tag);
}

/** Manual choice stored in the cookie, or "system". */
export function prefFromCookie(value: string | undefined | null): LocalePref {
  return isLocale(value) ? value : 'system';
}

export function getLocaleFromCookie(): LocalePref {
  if (typeof document === 'undefined') return 'system';
  const match = document.cookie.match(/(?:^|;\s*)locale=([^;]+)/);
  return prefFromCookie(match?.[1]);
}

export function setLocaleCookie(pref: LocalePref) {
  document.cookie =
    pref === 'system'
      ? `${LOCALE_COOKIE}=;path=/;max-age=0;samesite=lax`
      : `${LOCALE_COOKIE}=${pref};path=/;max-age=${365 * 24 * 60 * 60};samesite=lax`;
}
