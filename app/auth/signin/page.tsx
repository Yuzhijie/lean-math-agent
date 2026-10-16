'use client';

import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LogIn, Mail } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

export default function SignInPage() {
  const { tr } = useI18n();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl') || '/';
  const error = searchParams.get('error');

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <Card className="w-full max-w-md mx-4 bg-slate-800/50 border-slate-700 backdrop-blur-sm">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold text-white">{tr('登录', 'Sign in')}</CardTitle>
          <CardDescription className="text-slate-400">
            {tr(
              '邀请制内测：用受邀邮箱对应的 GitHub 或 Google 账号登录',
              'Invite-only beta: sign in with the GitHub or Google account of your invited email',
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="bg-red-500/10 border border-red-500/50 text-red-400 px-4 py-2 rounded-md text-sm">
              {error === 'AccessDenied'
                ? tr(
                    '目前是邀请制内测，这个账号的邮箱还不在邀请名单里。请联系管理员把邮箱加入名单。',
                    'This is an invite-only beta and this account’s email is not on the invite list yet. Ask the administrator to add it.',
                  )
                : error === 'OAuthSignin' || error === 'OAuthCallback'
                ? tr(
                    '第三方登录失败，请检查 OAuth 配置后重试',
                    'Third-party sign-in failed. Check the OAuth configuration and try again.',
                  )
                : tr('登录失败，请重试', 'Sign-in failed. Please try again.')}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Button
              variant="outline"
              onClick={() => signIn('github', { callbackUrl })}
              className="border-slate-600 hover:bg-slate-700 text-slate-300"
            >
              <LogIn className="mr-2 h-4 w-4" />
              GitHub
            </Button>
            <Button
              variant="outline"
              onClick={() => signIn('google', { callbackUrl })}
              className="border-slate-600 hover:bg-slate-700 text-slate-300"
            >
              <Mail className="mr-2 h-4 w-4" />
              Google
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
