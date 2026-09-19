/**
 * Tests for Stripe payment integration (mocked)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock stripe. The module is used as a constructor (`new Stripe(key)`), and
// since Vitest 4 a mock implemented by an arrow function is not constructible,
// so use a regular function expression.
vi.mock('stripe', () => {
  return {
    default: vi.fn(function MockStripeCtor() {
      return mockStripe;
    }),
  };
});

const mockStripe = {
  checkout: {
    sessions: {
      create: vi.fn(),
    },
  },
  billingPortal: {
    sessions: {
      create: vi.fn(),
    },
  },
  subscriptions: {
    retrieve: vi.fn(),
    cancel: vi.fn(),
  },
  webhooks: {
    constructEvent: vi.fn(),
  },
};

describe('Stripe Payments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_xxx');
    vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_xxx');
  });

  it('should have correct plan definitions', async () => {
    const { PLANS } = await import('../lib/payments/stripe');

    expect(PLANS.free.price).toBe(0);
    expect(PLANS.pro.price).toBe(49);
    expect(PLANS.enterprise.price).toBe(199);

    expect(PLANS.free.limits.proofsPerMonth).toBe(10);
    expect(PLANS.pro.limits.proofsPerMonth).toBe(500);
    expect(PLANS.enterprise.limits.proofsPerMonth).toBe(-1);
  });

  it('should create checkout session', async () => {
    mockStripe.checkout.sessions.create.mockResolvedValue({
      url: 'https://checkout.stripe.com/test',
    });

    const { createCheckoutSession } = await import('../lib/payments/stripe');
    const url = await createCheckoutSession('user_123', 'test@example.com', 'pro');

    expect(url).toBe('https://checkout.stripe.com/test');
    expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        customer_email: 'test@example.com',
        metadata: { userId: 'user_123', planId: 'pro' },
      })
    );
  });

  it('should reject checkout for free plan', async () => {
    const { createCheckoutSession } = await import('../lib/payments/stripe');

    await expect(
      createCheckoutSession('user_123', 'test@example.com', 'free')
    ).rejects.toThrow('Invalid plan');
  });

  it('should create billing portal session', async () => {
    mockStripe.billingPortal.sessions.create.mockResolvedValue({
      url: 'https://billing.stripe.com/test',
    });

    const { createBillingPortalSession } = await import('../lib/payments/stripe');
    const url = await createBillingPortalSession('cus_xxx');

    expect(url).toBe('https://billing.stripe.com/test');
  });

  it('should handle webhook events', async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { userId: 'user_123', planId: 'pro' },
          subscription: 'sub_xxx',
        },
      },
    });

    const { handleWebhook } = await import('../lib/payments/stripe');
    const event = await handleWebhook('payload', 'signature');

    expect(event.type).toBe('checkout.session.completed');
    expect(event.data.metadata.userId).toBe('user_123');
  });

  it('should get subscription', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_xxx',
      status: 'active',
    });

    const { getSubscription } = await import('../lib/payments/stripe');
    const sub = await getSubscription('sub_xxx');

    expect(sub.status).toBe('active');
  });

  it('should cancel subscription', async () => {
    mockStripe.subscriptions.cancel.mockResolvedValue({
      id: 'sub_xxx',
      status: 'canceled',
    });

    const { cancelSubscription } = await import('../lib/payments/stripe');
    const sub = await cancelSubscription('sub_xxx');

    expect(sub.status).toBe('canceled');
  });
});
