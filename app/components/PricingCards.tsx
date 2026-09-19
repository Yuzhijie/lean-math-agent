'use client';

import { useSession } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Check, Zap, Building2, Crown } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Plan {
  id: string;
  name: string;
  price: number;
  features: string[];
  icon: React.ReactNode;
  popular?: boolean;
}

const plans: Plan[] = [
  {
    id: 'free',
    name: '免费版',
    price: 0,
    features: [
      '每月 10 次证明',
      '7 天会话历史',
      '单线程求解',
      '基础方法推荐',
    ],
    icon: <Zap className="h-6 w-6" />,
  },
  {
    id: 'pro',
    name: '专业版',
    price: 49,
    features: [
      '每月 500 次证明',
      '无限会话历史',
      '并行求解',
      '高级方法推荐',
      '优先支持',
      '导出为 PDF',
    ],
    icon: <Crown className="h-6 w-6" />,
    popular: true,
  },
  {
    id: 'enterprise',
    name: '企业版',
    price: 199,
    features: [
      '无限证明',
      '团队协作',
      'API 访问',
      '自定义模型',
      '专属支持',
      'SLA 保障',
    ],
    icon: <Building2 className="h-6 w-6" />,
  },
];

export function PricingCards() {
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
              最受欢迎
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
              <span className="text-sm font-normal text-slate-400">/月</span>
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
              {loading === plan.id ? '处理中...' : plan.id === 'free' ? '当前计划' : '订阅'}
            </Button>
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}
