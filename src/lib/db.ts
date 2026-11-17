import { PrismaClient, Prisma } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Transactions get more time than Prisma's 5-second default. On Vercel the
// database is next door, but a slow moment (or running from a laptop far from
// the database) must not abort a payment halfway; it's rolled back cleanly
// only if it truly takes longer than this.
export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ transactionOptions: { maxWait: 10_000, timeout: 30_000 } });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/** A Prisma client or an open transaction; domain functions accept either. */
export type Db = PrismaClient | Prisma.TransactionClient;
