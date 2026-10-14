/**
 * Prisma client singleton
 * Used by NextAuth adapter and application database layer.
 * Prisma 7: the client is generated into lib/generated/prisma (`npx prisma generate`) and talks
 * to SQLite through the better-sqlite3 driver adapter.
 */
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@/lib/generated/prisma/client';
import { sqliteUrl } from '@/lib/db-url';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: sqliteUrl() }),
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
