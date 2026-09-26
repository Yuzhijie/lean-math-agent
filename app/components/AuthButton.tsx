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
import { LogIn, LogOut, User, Settings } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

export function AuthButton() {
  const { tr } = useI18n();
  const { data: session, status } = useSession();

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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="relative h-8 w-8 rounded-full">
          <Avatar className="h-8 w-8">
            <AvatarImage src={session.user?.image ?? ''} alt={session.user?.name ?? ''} />
            <AvatarFallback className="bg-amber-600 text-white">
              {session.user?.name?.[0]?.toUpperCase() ?? 'U'}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56 bg-slate-800 border-slate-700" align="end" forceMount>
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium text-white">{session.user?.name ?? tr('用户', 'User')}</p>
            <p className="text-xs text-slate-400">{session.user?.email}</p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="border-slate-700" />
        <DropdownMenuItem className="text-slate-300 focus:bg-slate-700 focus:text-white">
          <User className="mr-2 h-4 w-4" />
          <span>{tr('个人资料', 'Profile')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem className="text-slate-300 focus:bg-slate-700 focus:text-white">
          <Settings className="mr-2 h-4 w-4" />
          <span>{tr('设置', 'Settings')}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="border-slate-700" />
        <DropdownMenuItem
          className="text-red-400 focus:bg-slate-700 focus:text-red-300"
          onClick={() => signOut({ callbackUrl: '/' })}
        >
          <LogOut className="mr-2 h-4 w-4" />
          <span>{tr('退出登录', 'Sign out')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
