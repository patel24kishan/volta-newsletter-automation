/** Load .env if present. Node 22+ has this built in; no dependency. */
export function loadDotEnv(path = ".env"): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // no .env is fine; values may come from the real environment
  }
}
