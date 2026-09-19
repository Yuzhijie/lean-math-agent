/**
 * Stripe webhook handler
 * Processes subscription lifecycle events
 */
import { NextRequest, NextResponse } from 'next/server';
import { handleWebhook } from '@/lib/payments/stripe';
import { prisma } from '@/lib/db';

export async function POST(request: NextRequest) {
  const payload = await request.text();
  const signature = request.headers.get('stripe-signature')!;

  try {
    const event = await handleWebhook(payload, signature);

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data;
        const userId = session.metadata.userId;
        const planId = session.metadata.planId;

        await prisma.subscription.upsert({
          where: { userId },
          update: {
            plan: planId,
            status: 'active',
            startDate: new Date(),
            stripeSubscriptionId: session.subscription as string,
          },
          create: {
            userId,
            plan: planId,
            status: 'active',
            startDate: new Date(),
            stripeSubscriptionId: session.subscription as string,
          },
        });
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data;
        await prisma.subscription.update({
          where: { stripeSubscriptionId: subscription.id },
          data: {
            status: subscription.status === 'active' ? 'active' : 'cancelled',
            endDate: subscription.cancel_at ? new Date(subscription.cancel_at * 1000) : null,
          },
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data;
        await prisma.subscription.update({
          where: { stripeSubscriptionId: subscription.id },
          data: {
            status: 'expired',
            endDate: new Date(),
          },
        });
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data;
        const subscription = await prisma.subscription.findFirst({
          where: { stripeSubscriptionId: invoice.subscription as string },
        });
        if (subscription) {
          // Send notification email (TODO: implement)
          console.warn(`Payment failed for subscription ${subscription.id}`);
        }
        break;
      }
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return NextResponse.json(
      { error: 'Webhook handler failed' },
      { status: 400 }
    );
  }
}
