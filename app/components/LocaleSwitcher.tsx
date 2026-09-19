'use client';

import { useI18n } from '@/lib/i18n';
import { locales, localeNames, Locale } from '@/lib/i18n/config';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Globe } from 'lucide-react';

export function LocaleSwitcher() {
  const { locale, setLocale } = useI18n();

  return (
    <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
      <SelectTrigger className="w-[120px] border-slate-600 bg-slate-800/50 text-slate-300">
        <Globe className="mr-2 h-4 w-4" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="bg-slate-800 border-slate-700">
        {locales.map((loc) => (
          <SelectItem
            key={loc}
            value={loc}
            className="text-slate-300 focus:bg-slate-700 focus:text-white"
          >
            {localeNames[loc]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
