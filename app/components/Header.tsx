'use client';

import { AuthButton } from '@/app/components/AuthButton';
import { LocaleSwitcher } from '@/app/components/LocaleSwitcher';
import { Button } from '@/components/ui/button';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Crown, BookOpen, History, Network } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

export function Header() {
  const { tr } = useI18n();
  const { data: session } = useSession();
  const router = useRouter();

  return (
    <header className="border-b border-slate-700/50 bg-slate-900/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center">
            <BookOpen className="h-4 w-4 text-white" />
          </div>
          <span className="font-bold text-white hidden sm:inline">Lean Math Agent</span>
        </div>

        {/* Navigation */}
        <nav className="flex items-center gap-2">
          {session && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => router.push('/history')}
                className="text-slate-400 hover:text-white"
              >
                <History className="h-4 w-4 mr-1" />
                <span className="hidden md:inline">{tr('历史', 'History')}</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => router.push('/knowledge')}
                className="text-slate-400 hover:text-white"
              >
                <Network className="h-4 w-4 mr-1" />
                <span className="hidden md:inline">{tr('知识图谱', 'Knowledge graph')}</span>
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push('/subscription')}
            className="text-amber-500 hover:text-amber-400"
          >
            <Crown className="h-4 w-4 mr-1" />
            <span className="hidden md:inline">{tr('订阅', 'Subscription')}</span>
          </Button>
          <LocaleSwitcher />
          <AuthButton />
        </nav>
      </div>
    </header>
  );
}
