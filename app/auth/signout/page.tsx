'use client';

import { signOut } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useI18n } from '@/lib/i18n';

export default function SignOutPage() {
  const { tr } = useI18n();
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <Card className="w-full max-w-md mx-4 bg-slate-800/50 border-slate-700 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="text-2xl font-bold text-white">{tr('退出登录', 'Sign out')}</CardTitle>
          <CardDescription className="text-slate-400">
            {tr('确定要退出登录吗？', 'Are you sure you want to sign out?')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-4">
          <Button
            variant="outline"
            onClick={() => window.history.back()}
            className="flex-1 border-slate-600 hover:bg-slate-700 text-slate-300"
          >
            {tr('取消', 'Cancel')}
          </Button>
          <Button
            onClick={() => signOut({ callbackUrl: '/' })}
            className="flex-1 bg-red-600 hover:bg-red-700 text-white"
          >
            {tr('退出', 'Sign out')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
