'use client';

import { useSession } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Check, Zap, Building2, Crown } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';

interface Plan {
  id: string;
  name: string;
  price: number;
  features: string[];
  icon: React.ReactNode;
  popular?: boolean;
}

function getPlans(tr: (zh: string, en: string) => string): Plan[] {
  return [
    {
      id: 'free',
      name: tr('免费版', 'Free'),
      price: 0,
      features: [
        tr('每月 10 次证明', '10 proofs per month'),
        tr('7 天会话历史', '7-day session history'),
        tr('单线程求解', 'Single-threaded solving'),
        tr('基础方法推荐', 'Basic method recommendations'),
      ],
      icon: <Zap className="h-6 w-6" />,
    },
    {
      id: 'pro',
      name: tr('专业版', 'Pro'),
      price: 49,
      features: [
        tr('每月 500 次证明', '500 proofs per month'),
        tr('无限会话历史', 'Unlimited session history'),
        tr('并行求解', 'Parallel solving'),
        tr('高级方法推荐', 'Advanced method recommendations'),
        tr('优先支持', 'Priority support'),
        tr('导出为 PDF', 'Export to PDF'),
      ],
      icon: <Crown className="h-6 w-6" />,
      popular: true,
    },
    {
      id: 'enterprise',
      name: tr('企业版', 'Enterprise'),
      price: 199,
      features: [
        tr('无限证明', 'Unlimited proofs'),
        tr('团队协作', 'Team collaboration'),
        tr('API 访问', 'API access'),
        tr('自定义模型', 'Custom models'),
        tr('专属支持', 'Dedicated support'),
        tr('SLA 保障', 'SLA guarantee'),
      ],
      icon: <Building2 className="h-6 w-6" />,
    },
  ];
}

export function PricingCards() {
  const { tr } = useI18n();
  const plans = getPlans(tr);
  const { data: session } = useSession();
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);

  const handleSubscribe = async (planId: string) => {
    if (!session) {
      router.push('/auth/signin?callbackUrl=/subscription');
      return;
    }

    if (planId === 'free') {
      return;
    }

    setLoading(planId);
    try {
      const res = await fetch('/api/payments/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId }),
      });
      const { url } = await res.json();
      if (url) {
        window.location.href = url;
      }
    } catch (error) {
      console.error('Checkout failed:', error);
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-6xl mx-auto">
      {plans.map((plan) => (
        <Card
          key={plan.id}
          className={`relative bg-slate-800/50 border-slate-700 ${
            plan.popular ? 'border-amber-500/50 shadow-lg shadow-amber-500/10' : ''
          }`}
        >
          {plan.popular && (
            <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 bg-amber-600">
              {tr('最受欢迎', 'Most popular')}
            </Badge>
          )}
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${plan.popular ? 'bg-amber-600/20 text-amber-500' : 'bg-slate-700 text-slate-400'}`}>
                {plan.icon}
              </div>
              <div>
                <CardTitle className="text-white">{plan.name}</CardTitle>
              </div>
            </div>
            <CardDescription className="text-3xl font-bold text-white mt-4">
              ¥{plan.price}
              <span className="text-sm font-normal text-slate-400">{tr('/月', '/mo')}</span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {plan.features.map((feature, i) => (
                <li key={i} className="flex items-center gap-2 text-slate-300">
                  <Check className="h-4 w-4 text-green-500 flex-shrink-0" />
                  <span className="text-sm">{feature}</span>
                </li>
              ))}
            </ul>
          </CardContent>
          <CardFooter>
            <Button
              className={`w-full ${
                plan.popular
                  ? 'bg-amber-600 hover:bg-amber-700 text-white'
                  : 'bg-slate-700 hover:bg-slate-600 text-white'
              }`}
              onClick={() => handleSubscribe(plan.id)}
              disabled={loading === plan.id || plan.id === 'free'}
            >
              {loading === plan.id
                ? tr('处理中...', 'Processing...')
                : plan.id === 'free'
                  ? tr('当前计划', 'Current plan')
                  : tr('订阅', 'Subscribe')}
            </Button>
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}
