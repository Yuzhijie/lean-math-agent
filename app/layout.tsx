import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { Inter, Source_Serif_4, JetBrains_Mono } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { Providers } from "./providers";
import { I18nProvider } from "@/lib/i18n";
import { LOCALE_COOKIE, matchLocale, parseAcceptLanguage, prefFromCookie, type Locale, type LocalePref } from "@/lib/i18n/config";

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ui",
  display: "swap",
});

const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-heading",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-code",
  display: "swap",
});

/** Manual choice (cookie) and the system language (Accept-Language) for the first render. */
async function resolveLocale(): Promise<{ pref: LocalePref; system: Locale; locale: Locale }> {
  const pref = prefFromCookie((await cookies()).get(LOCALE_COOKIE)?.value);
  const system = matchLocale(parseAcceptLanguage((await headers()).get("accept-language")));
  return { pref, system, locale: pref === "system" ? system : pref };
}

export async function generateMetadata(): Promise<Metadata> {
  const { locale } = await resolveLocale();
  return {
    title: locale === "en-US" ? "Lean Math Agent — AI theorem proving" : "Lean Math Agent — AI 数学定理证明",
    description: "AI-powered Lean 4 math theorem prover and problem solver",
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { pref, system, locale } = await resolveLocale();
  return (
    <html
      lang={locale}
      className={`dark ${inter.variable} ${sourceSerif.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body className="math-bg antialiased">
        <Providers>
          <I18nProvider initialPref={pref} initialSystemLocale={system}>
            {children}
          </I18nProvider>
        </Providers>
      </body>
    </html>
  );
}
