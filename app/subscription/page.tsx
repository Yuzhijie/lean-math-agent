'use client';

import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { PricingCards } from '@/app/components/PricingCards';
import { AuthButton } from '@/app/components/AuthButton';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Crown } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

export default function SubscriptionPage() {
  const { tr } = useI18n();
  const { data: session, status } = useSession();
  const router = useRouter();

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <div className="animate-spin h-8 w-8 border-2 border-amber-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      {/* Header */}
      <header className="border-b border-slate-700/50 bg-slate-900/50 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              onClick={() => router.push('/')}
              className="text-slate-400 hover:text-white"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              {tr('返回', 'Back')}
            </Button>
            <h1 className="text-xl font-bold text-white flex items-center gap-2">
              <Crown className="h-5 w-5 text-amber-500" />
              {tr('订阅计划', 'Subscription plans')}
            </h1>
          </div>
          <AuthButton />
        </div>
      </header>

      {/* Content */}
      <main className="max-w-7xl mx-auto px-4 py-12">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold text-white mb-4">
            {tr('选择适合您的计划', 'Choose the plan that fits you')}
          </h2>
          <p className="text-slate-400 max-w-2xl mx-auto">
            {tr(
              '从免费版开始体验 AI 数学证明，升级解锁更多功能',
              'Start with the free plan to try AI-powered math proofs, and upgrade to unlock more features',
            )}
          </p>
        </div>

        <PricingCards />

        {/* FAQ */}
        <div className="mt-16 max-w-3xl mx-auto">
          <h3 className="text-2xl font-bold text-white mb-8 text-center">{tr('常见问题', 'FAQ')}</h3>
          <div className="space-y-6">
            <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-6">
              <h4 className="text-white font-medium mb-2">{tr('免费版有什么限制？', 'What are the limits of the free plan?')}</h4>
              <p className="text-slate-400 text-sm">
                {tr(
                  '免费版每月可证明 10 个定理，保留 7 天会话历史，使用单线程求解。对于学习和探索完全足够。',
                  'The free plan lets you prove 10 theorems per month, keeps 7 days of session history and uses single-threaded solving. That is plenty for learning and exploration.',
                )}
              </p>
            </div>
            <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-6">
              <h4 className="text-white font-medium mb-2">{tr('如何取消订阅？', 'How do I cancel my subscription?')}</h4>
              <p className="text-slate-400 text-sm">
                {tr(
                  '您可以随时在账户设置中取消订阅。取消后，当前计费周期结束前仍可使用所有功能。',
                  'You can cancel at any time in your account settings. After cancelling, you keep access to all features until the end of the current billing period.',
                )}
              </p>
            </div>
            <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-6">
              <h4 className="text-white font-medium mb-2">{tr('支持哪些支付方式？', 'Which payment methods are supported?')}</h4>
              <p className="text-slate-400 text-sm">
                {tr(
                  '我们支持信用卡（Visa、Mastercard）、支付宝和微信支付。企业版支持对公转账。',
                  'We accept credit cards (Visa, Mastercard), Alipay and WeChat Pay. Enterprise plans can also pay by bank transfer.',
                )}
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
