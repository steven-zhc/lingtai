/**
 * Next calls `register()` once, bare, when the server starts (#775). **No
 * top-level imports**: Next compiles this file for the edge runtime too, and
 * `@lingtai/env` reads `node:fs`. Everything is behind the runtime check.
 */
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return
  const { installTracing } = await import('./lib/telemetry.ts')
  await installTracing(process.env)
}
