'use client';

import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { KnowledgeGraph } from '@/app/components/KnowledgeGraph';
import { Header } from '@/app/components/Header';

export default function KnowledgePage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <div className="animate-spin h-8 w-8 border-2 border-amber-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!session) {
    router.push('/auth/signin?callbackUrl=/knowledge');
    return null;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <Header />
      <main className="max-w-7xl mx-auto px-4 py-8">
        <KnowledgeGraph />
      </main>
    </div>
  );
}
