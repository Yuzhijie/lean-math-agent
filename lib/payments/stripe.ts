/**
 * Stripe payment integration
 * Handles subscriptions, one-time payments, and webhooks
 */
import Stripe from 'stripe';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-06-20',
});

export interface SubscriptionPlan {
  id: string;
  name: string;
  priceId: string;
  price: number;
  currency: string;
  interval: 'month' | 'year';
  features: string[];
  limits: {
    proofsPerMonth: number;
    sessionHistory: number;
    concurrentSolvers: number;
  };
}

export const PLANS: Record<string, SubscriptionPlan> = {
  free: {
    id: 'free',
    name: '免费版',
    priceId: '',
    price: 0,
    currency: 'CNY',
    interval: 'month',
    features: [
      '每月 10 次证明',
      '7 天会话历史',
      '单线程求解',
      '基础方法推荐',
    ],
    limits: {
      proofsPerMonth: 10,
      sessionHistory: 7,
      concurrentSolvers: 1,
    },
  },
  pro: {
    id: 'pro',
    name: '专业版',
    priceId: process.env.STRIPE_PRO_PRICE_ID!,
    price: 49,
    currency: 'CNY',
    interval: 'month',
    features: [
      '每月 500 次证明',
      '无限会话历史',
      '并行求解',
      '高级方法推荐',
      '优先支持',
      '导出为 PDF',
    ],
    limits: {
      proofsPerMonth: 500,
      sessionHistory: -1,
      concurrentSolvers: 4,
    },
  },
  enterprise: {
    id: 'enterprise',
    name: '企业版',
    priceId: process.env.STRIPE_ENTERPRISE_PRICE_ID!,
    price: 199,
    currency: 'CNY',
    interval: 'month',
    features: [
      '无限证明',
      '团队协作',
      'API 访问',
      '自定义模型',
      '专属支持',
      'SLA 保障',
    ],
    limits: {
      proofsPerMonth: -1,
      sessionHistory: -1,
      concurrentSolvers: -1,
    },
  },
};

export async function createCheckoutSession(
  userId: string,
  email: string,
  planId: string
): Promise<string> {
  const plan = PLANS[planId];
  if (!plan || planId === 'free') {
    throw new Error('Invalid plan');
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card', 'alipay'],
    customer_email: email,
    line_items: [
      {
        price: plan.priceId,
        quantity: 1,
      },
    ],
    success_url: `${process.env.NEXTAUTH_URL}/subscription?success=true`,
    cancel_url: `${process.env.NEXTAUTH_URL}/subscription?canceled=true`,
    metadata: {
      userId,
      planId,
    },
  });

  return session.url!;
}

export async function createBillingPortalSession(
  customerId: string
): Promise<string> {
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${process.env.NEXTAUTH_URL}/subscription`,
  });

  return session.url;
}

export async function getSubscription(subscriptionId: string) {
  return stripe.subscriptions.retrieve(subscriptionId);
}

export async function cancelSubscription(subscriptionId: string) {
  return stripe.subscriptions.cancel(subscriptionId);
}

export async function handleWebhook(
  payload: string | Buffer,
  signature: string
): Promise<{ type: string; data: any }> {
  const event = stripe.webhooks.constructEvent(
    payload,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET!
  );

  return { type: event.type, data: event.data.object };
}
