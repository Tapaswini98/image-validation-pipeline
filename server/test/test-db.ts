/** Integration tests use their own database so they never leave rows that running workers pick up. */
export function testDatabaseUrl(): string {
  const url = new URL(process.env.DATABASE_URL ?? 'postgresql://app:app@localhost:5433/images');
  url.pathname = '/images_test';
  return url.toString();
}
