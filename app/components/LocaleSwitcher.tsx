'use client';

import { Check, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { locales, localeNames, localeShort, type LocalePref } from '@/lib/i18n/config';

/**
 * Language button: follows the system language by default; a manual choice
 * is remembered (cookie) until "follow system" is picked again.
 */
export function LocaleSwitcher() {
  const { locale, pref, systemLocale, setPref, tr } = useI18n();
  const item = (p: LocalePref, label: string) => (
    <DropdownMenuItem key={p} onSelect={() => setPref(p)} className="flex items-center justify-between gap-4">
      <span>{label}</span>
      {pref === p && <Check className="h-3.5 w-3.5 text-primary" />}
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5" aria-label={tr('切换语言', 'Change language')} title={tr('切换语言', 'Change language')}>
          <Globe className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">{localeShort[locale]}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        {item('system', tr(`跟随系统（${localeNames[systemLocale]}）`, `Follow system (${localeNames[systemLocale]})`))}
        <DropdownMenuSeparator />
        {locales.map((l) => item(l, localeNames[l]))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
