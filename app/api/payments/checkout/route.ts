/**
 * Stripe checkout API - Create subscription checkout session
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { createCheckoutSession, PLANS } from '@/lib/payments/stripe';
import { frozenRoute } from '@/lib/scope';

async function handlePOST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { planId } = await request.json();

    if (!planId || !PLANS[planId]) {
      return NextResponse.json({ error: 'Invalid plan' }, { status: 400 });
    }

    if (planId === 'free') {
      return NextResponse.json({ error: 'Free plan does not require checkout' }, { status: 400 });
    }

    const checkoutUrl = await createCheckoutSession(
      session.user.id,
      session.user.email!,
      planId
    );

    return NextResponse.json({ url: checkoutUrl });
  } catch (error) {
    console.error('Checkout error:', error);
    return NextResponse.json(
      { error: 'Failed to create checkout session' },
      { status: 500 }
    );
  }
}

// Frozen (lib/scope.ts, docs/SCOPE.md): 404 unless THAW names "payments".
export const POST = frozenRoute('payments', handlePOST);
