import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { testDatabaseUrl } from './test-db';

/** Creates the images_test database if needed and applies migrations to it. */
export default async function globalSetup() {
  try {
    process.loadEnvFile();
  } catch {
    // no .env: rely on the environment
  }
  const admin = new PrismaClient();
  const exists = await admin.$queryRaw<unknown[]>`SELECT 1 FROM pg_database WHERE datname = 'images_test'`;
  if (exists.length === 0) await admin.$executeRawUnsafe('CREATE DATABASE images_test');
  await admin.$disconnect();

  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    stdio: 'ignore',
  });
}
