// Node 20.12+ built-in .env loader (no dotenv dependency). Real env vars take precedence.
try {
  process.loadEnvFile();
} catch {
  // no .env file: rely on the real environment (e.g. in containers)
}
