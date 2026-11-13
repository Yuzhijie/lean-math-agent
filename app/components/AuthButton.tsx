'use client';

import { useSession, signIn, signOut } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { LogIn, LogOut } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

/**
 * The account control: who is signed in, and signing out. `signedInOnly` (the product's own pages)
 * shows nothing until there is a signed-in user — on a machine without sign-in (the local single
 * user) there is no account to show, and where sign-in is required nobody reaches a page without one.
 */
export function AuthButton({ signedInOnly = false }: { signedInOnly?: boolean }) {
  const { tr } = useI18n();
  const { data: session, status } = useSession();

  if (signedInOnly && !session) return null;

  if (status === 'loading') {
    return (
      <Button variant="ghost" disabled className="text-slate-400">
        {tr('加载中...', 'Loading...')}
      </Button>
    );
  }

  if (!session) {
    return (
      <Button
        variant="outline"
        onClick={() => signIn()}
        className="border-amber-600/50 hover:bg-amber-600/10 text-amber-500"
      >
        <LogIn className="mr-2 h-4 w-4" />
        {tr('登录', 'Sign in')}
      </Button>
    );
  }

  const who = session.user?.name ?? session.user?.email ?? '';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="relative h-8 w-8 shrink-0 rounded-full p-0" aria-label={tr('账号', 'Account')}>
          <Avatar className="h-8 w-8">
            <AvatarImage src={session.user?.image ?? ''} alt={who} />
            <AvatarFallback className="bg-primary/20 text-sm font-medium text-primary">
              {who[0]?.toUpperCase() ?? 'U'}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60" align="end">
        <DropdownMenuLabel className="font-normal">
          <div className="flex min-w-0 flex-col space-y-1">
            <p className="truncate text-sm font-medium text-foreground">{session.user?.name ?? tr('用户', 'User')}</p>
            {session.user?.email && <p className="truncate text-xs text-muted-foreground">{session.user.email}</p>}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => signOut({ callbackUrl: '/' })}>
          <LogOut className="mr-2 h-4 w-4" />
          <span>{tr('退出登录', 'Sign out')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
