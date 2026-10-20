import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __backendPrisma: PrismaClient | undefined;
}

let prisma: PrismaClient | null = null;
let prismaInitialized = false;

export function getPrismaClient(): PrismaClient | null {
  if (prismaInitialized) return prisma;

  if (!process.env.DATABASE_URL) {
    prismaInitialized = true;
    console.warn('⚠️ DATABASE_URL não configurado.');
    return null;
  }

  try {
    if (global.__backendPrisma) {
      prisma = global.__backendPrisma;
      prismaInitialized = true;
      return prisma;
    }

    prisma = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    });
    

    global.__backendPrisma = prisma;
    prismaInitialized = true;
    console.log('✅ Prisma Client inicializado no backend.');
    return prisma;
  } catch (err) {
    prismaInitialized = true;
    prisma = null;
    console.error('❌ Erro ao inicializar Prisma Client no backend:', err);
    return null;
  }
}

export function getDatabaseStatus() {
  return {
    provider: 'PostgreSQL (Prisma ORM + Supabase)',
    prismaConnected: Boolean(process.env.DATABASE_URL) && prismaInitialized && prisma !== null,
    mode: process.env.DATABASE_URL ? 'PostgreSQL Database (Supabase)' : 'In-Memory DB (Modo Demo)',
  };
}
