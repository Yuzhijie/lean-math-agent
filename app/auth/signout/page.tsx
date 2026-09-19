'use client';

import { signOut } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function SignOutPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <Card className="w-full max-w-md mx-4 bg-slate-800/50 border-slate-700 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="text-2xl font-bold text-white">退出登录</CardTitle>
          <CardDescription className="text-slate-400">
            确定要退出登录吗？
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-4">
          <Button
            variant="outline"
            onClick={() => window.history.back()}
            className="flex-1 border-slate-600 hover:bg-slate-700 text-slate-300"
          >
            取消
          </Button>
          <Button
            onClick={() => signOut({ callbackUrl: '/' })}
            className="flex-1 bg-red-600 hover:bg-red-700 text-white"
          >
            退出
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
