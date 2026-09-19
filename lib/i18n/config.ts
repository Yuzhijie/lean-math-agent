/**
 * Internationalization configuration
 * Supports: zh-CN (default), en-US
 */
export const locales = ['zh-CN', 'en-US'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'zh-CN';

export const localeNames: Record<Locale, string> = {
  'zh-CN': '简体中文',
  'en-US': 'English',
};

export function getLocaleFromCookie(): Locale {
  if (typeof document === 'undefined') return defaultLocale;
  const match = document.cookie.match(/locale=(zh-CN|en-US)/);
  return (match?.[1] as Locale) ?? defaultLocale;
}

export function setLocaleCookie(locale: Locale) {
  document.cookie = `locale=${locale};path=/;max-age=${365 * 24 * 60 * 60}`;
}
