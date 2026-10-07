/**
 * Whether this machine has a GitHub App configured, and whether it still
 * answers — `GET /app` with the App's own JWT, the call that proves the id and
 * the key belong together (#393, #394).
 *
 * Pulled out of `init.ts` so `first-project.ts` can ask the same question for
 * `lingtai add` without importing `init.ts` — the two files would otherwise
 * import each other, since `init.ts` calls into `first-project.ts` for
 * `chooseFirstProject`.
 */
export type AppCheck =
  | { configured: false }
  | { configured: true; ok: true; slug: string; owner: string }
  | { configured: true; ok: false; why: string }

export async function checkApp(): Promise<AppCheck> {
  const env = await import('@lingtai/env')
  if (!env.hasGitHubApp()) return { configured: false }
  try {
    const github = await import('@lingtai/github')
    const credentials = env.githubApp()
    const reader = github.createAppReader({ appId: credentials.appId, privateKey: credentials.privateKey })
    const app = await reader.request<{ slug: string; owner: { login: string } }>('GET', '/app', 'app')
    return { configured: true, ok: true, slug: app.slug, owner: app.owner.login }
  } catch (err) {
    return { configured: true, ok: false, why: (err as Error).message }
  }
}

/**
 * Resolves once an App is configured and answers; stops polling once `signal`
 * aborts — the loser of a race against a keypress or a timeout
 * (`waitForApp`).
 */
export function pollForApp(signal: AbortSignal): Promise<{ slug: string; owner: string }> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      if (signal.aborted) return
      const app = await checkApp()
      if (signal.aborted) return
      if (app.configured && app.ok) {
        resolve({ slug: app.slug, owner: app.owner })
        return
      }
      timer = setTimeout(poll, 2000)
    }
    signal.addEventListener(
      'abort',
      () => {
        if (timer) clearTimeout(timer)
      },
      { once: true },
    )
    void poll()
  })
}
