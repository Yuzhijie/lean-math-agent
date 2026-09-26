/**
 * i18n context and hooks.
 *
 * - `t(key)` looks up a key in the message catalogues (zh-CN.ts / en-US.ts).
 * - `tr(zh, en)` picks between an inline Chinese and English string; most
 *   UI text uses this so each string stays next to its translation.
 *
 * The locale follows the system language unless the user picked one in the
 * language switcher (see config.ts). The server passes the locale it
 * resolved (cookie or Accept-Language) so the first render already matches.
 */
'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { type Locale, type LocalePref, defaultLocale, matchLocale, setLocaleCookie } from './config';
import zhCN from './zh-CN';
import enUS from './en-US';

type Messages = typeof zhCN;

const translations: Record<Locale, Messages> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

interface I18nContextType {
  /** Locale in effect. */
  locale: Locale;
  /** What the user chose: a locale, or "system". */
  pref: LocalePref;
  /** Locale the operating system / browser asks for. */
  systemLocale: Locale;
  setPref: (pref: LocalePref) => void;
  /** @deprecated use setPref */
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, string>) => string;
  tr: (zh: string, en: string) => string;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

function subscribeLanguages(onChange: () => void) {
  window.addEventListener('languagechange', onChange);
  return () => window.removeEventListener('languagechange', onChange);
}

export function I18nProvider({
  children,
  initialPref = 'system',
  initialSystemLocale = defaultLocale,
}: {
  children: ReactNode;
  initialPref?: LocalePref;
  /** System locale as the server saw it (Accept-Language), used until the browser reports its own. */
  initialSystemLocale?: Locale;
}) {
  const [pref, setPrefState] = useState<LocalePref>(initialPref);
  const systemLocale = useSyncExternalStore(
    subscribeLanguages,
    () => matchLocale(navigator.languages?.length ? navigator.languages : [navigator.language]),
    () => initialSystemLocale,
  );
  const locale: Locale = pref === 'system' ? systemLocale : pref;

  useEffect(() => {
    document.documentElement.lang = locale;
    // Tell the server which language is on screen, so model-written content (problems, solutions) matches it.
    document.cookie = `ui_locale=${locale};path=/;max-age=${365 * 24 * 60 * 60};samesite=lax`;
  }, [locale]);

  const setPref = useCallback((p: LocalePref) => {
    setPrefState(p);
    setLocaleCookie(p);
  }, []);

  const value = useMemo<I18nContextType>(() => {
    const t = (key: string, params?: Record<string, string>): string => {
      let v: unknown = translations[locale];
      for (const k of key.split('.')) v = (v as Record<string, unknown> | undefined)?.[k];
      if (typeof v !== 'string') return key;
      return params ? Object.entries(params).reduce((s, [k, p]) => s.replace(`{${k}}`, p), v) : v;
    };
    const tr = (zh: string, en: string) => (locale === 'en-US' ? en : zh);
    return { locale, pref, systemLocale, setPref, setLocale: setPref, t, tr };
  }, [locale, pref, systemLocale, setPref]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return context;
}

export type { Messages };
