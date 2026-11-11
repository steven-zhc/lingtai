/**
 * Step 0 of onboarding: which repository (#168).
 *
 * [The design](../../../doc/design/the-onboarding-wizard.md) opens at *step one
 * reads the base branch*, by which point a slug is already in hand, and
 * `lingtai add` makes installation a precondition rather than a step. This is
 * the step before both: **the installation is the entry point, not the link.**
 *
 * ```
 * 1. no installation  → a link to https://github.com/apps/<slug>/installations/new?state=…
 * 2. GitHub returns   → setup URL ?installation_id=…&setup_action=install|update|request
 * 3. what the App can see: GET /app/installations, then GET /installation/repositories
 * 4. a person picks from the list, or pastes a link that is checked against it
 * ```
 *
 * Since #401 step 4 is `lingtai add`, not a board screen: the board's own
 * `/setup/repository` only answers GitHub's redirect and names the command,
 * and this module's two callers for step 3 and 4 are `add-github.ts` and
 * `first-project.ts`.
 *
 * **Nothing is written.** Every call here goes through `AppReader`, whose only
 * method is `GET`, and nothing touches the event store: the registered
 * projects are handed in, already reduced, so that they can be *shown* as
 * registered rather than offered twice. Abandon this screen and there is
 * nothing to clean up, which is #160's rule.
 *
 * **Progress is read back from GitHub, never carried in the round trip.**
 * `state` survives only on `/installations/new`, and it does not survive an
 * organisation owner's approval — a member requests, an owner approves minutes
 * or days later, and that return has no `state`. So nothing here depends on
 * it: what asks the App what it can see now, with or without `state`, is
 * `listRepositories`, called from `lingtai add` rather than from the return
 * itself.
 */
import {
  type AppReader,
  GitHubFailed,
  type Installation,
  type PermissionGap,
  gapRemedyLines,
  parseSlug,
} from '@lingtai/github'
import { type Picker, same } from '@lingtai/setup'

/** A link that fixes the thing, and what to call it. */
export interface Fix {
  href: string
  label: string
}

export type Choice =
  | { ok: true; owner: string; repo: string; slug: string; installation: Installation }
  | {
      ok: false
      /** One sentence: why this repository cannot be taken from here. */
      why: string
      /** The page that fixes it, when there is one. */
      fix: Fix | null
      /** Missing scopes, one by one, when that is the reason. */
      gaps: PermissionGap[]
      /** The App's slug, when the reason is a gap, so its permissions page can be named. */
      appSlug?: string | null
    }

/**
 * A refused `Choice`'s own sentence, its gaps named one by one, then the fix
 * link — the whole of what a person is told, never just `why` on its own
 * (`add()`'s gap listing never runs on this path, so this is where that detail
 * has to live). `choose()`'s two callers, `first-project.ts` and
 * `add-github.ts`, both print through this. Since #401 the board's own
 * repository page calls neither `choose()` nor this: it is the terminal's
 * command that resolves a choice now.
 */
export function refusalLines(choice: {
  why: string
  fix: Fix | null
  gaps: PermissionGap[]
  appSlug?: string | null
}): string[] {
  const lines = [choice.why]
  if (choice.gaps.length > 0) {
    lines.push('the installation is missing permissions:')
    for (const g of choice.gaps) lines.push(`  ${g.name}: have ${g.have}, need ${g.need} — ${g.why}`)
    lines.push(...gapRemedyLines(choice.appSlug ?? null, choice.fix?.href ?? null))
    return lines
  }
  if (choice.fix !== null) lines.push(`${choice.fix.label}: ${choice.fix.href}`)
  return lines
}

/**
 * Whether the App's list already has this repository as one of Lingtai's
 * projects — registered, pending, or recorded under another owner.
 *
 * `choose()`'s *already onboarded* is written for the picker's offer-it-once
 * screen, not for re-running `lingtai add` on a project this is (the
 * `registrationLine` "updated" path, #163). So both CLI callers ask this first
 * and skip `choose()` when it is: `first-project.ts`, because `add()` resolves
 * the installation itself, and `add-github.ts`, because there the real reason
 * for the refusal is `checkInstallation`'s own gap list, which `choose()`'s
 * sentence would replace (#402).
 */
export function alreadyOnboarded(picker: Picker, slug: string): boolean {
  const { owner, repo } = parseSlug(slug)
  return picker.installations
    .flatMap((listed) => listed.repositories)
    .some(
      (r) =>
        r.owner.toLowerCase() === owner.toLowerCase() &&
        r.repo.toLowerCase() === repo.toLowerCase() &&
        (r.onboarded === 'registered' || r.onboarded === 'pending' || r.onboarded === 'unrecorded'),
    )
}

/**
 * A repository, named by a click or by a pasted link, checked against the list.
 *
 * **The list decides, not the input.** A pasted slug is `parseSlug`'s — every
 * shape a clipboard has — and then it has to be something the App can see. A
 * repository that is not says why, and links to the page that fixes it:
 * `installation.htmlUrl` when the App is installed on that owner and not on
 * that repository, the install link when it is not installed there at all.
 * That is the deep link Vercel's knowledge-base page for *unable to find your
 * GitHub repository* does not give.
 */
export function choose(picker: Picker, input: string): Choice {
  let owner: string
  let repo: string
  try {
    ;({ owner, repo } = parseSlug(input))
  } catch (err) {
    return { ok: false, why: (err as Error).message, fix: null, gaps: [] }
  }
  const slug = `${owner}/${repo}`

  for (const listed of picker.installations) {
    const found = listed.repositories.find((r) => same(r.owner, owner) && same(r.repo, repo))
    if (found === undefined) continue
    if (found.onboarded !== null) {
      return {
        ok: false,
        why:
          found.onboarded === 'registered'
            ? `${found.slug} is already onboarded.`
            : found.onboarded === 'pending'
              ? `${found.slug} is already on its way in — its recipe is on this machine, and it is waiting for Recheck on the board's pending card to register it.`
              : found.onboarded === 'taken'
                ? taken(found)
                : unrecorded(found),
        fix: null,
        gaps: [],
      }
    }
    if (listed.gaps.length > 0) {
      return {
        ok: false,
        why: `The App can see ${found.slug}, but its installation on ${listed.installation.account} is missing permissions.`,
        fix: settings(listed.installation, "Accept them on the installation's page"),
        gaps: listed.gaps,
        appSlug: listed.installation.appSlug,
      }
    }
    return { ok: true, owner: found.owner, repo: found.repo, slug: found.slug, installation: listed.installation }
  }

  const onOwner = picker.installations.find((l) => same(l.installation.account, owner))
  if (onOwner === undefined) {
    return {
      ok: false,
      why: `The App is not installed on ${owner}, so it cannot see ${slug}.`,
      fix: picker.installUrl === null ? null : { href: picker.installUrl, label: `Install it on ${owner}` },
      gaps: [],
    }
  }
  if (onOwner.unanswered !== null) {
    return {
      ok: false,
      why: `GitHub would not say what the App can see on ${onOwner.installation.account} — ${onOwner.unanswered}.`,
      fix: settings(onOwner.installation, `Check the installation on ${onOwner.installation.account}`),
      gaps: [],
    }
  }
  return {
    ok: false,
    why:
      onOwner.installation.repositorySelection === 'selected'
        ? `The App is installed on ${onOwner.installation.account} for selected repositories, and ${slug} is not one of them.`
        : `The App can see every repository on ${onOwner.installation.account}, and ${slug} is not among them — ` +
          'check the name, or whether it has moved.',
    fix: settings(onOwner.installation, `Add ${repo} on the installation's page`),
    gaps: onOwner.gaps,
    appSlug: onOwner.installation.appSlug,
  }
}

/** What a name registered before owners were can and cannot say, and how to settle it. */
export function unrecorded(repo: { repo: string }): string {
  return (
    `A project called ${repo.repo} was registered before owners were recorded, and the App cannot see ${repo.repo} ` +
    `under exactly one account with every installation answering, so Lingtai cannot tell which it is. ` +
    `Run pnpm lingtai add <owner>/${repo.repo} for the one it is, and that owner is recorded.`
  )
}

/** Why a repository whose name another owner's project already has is not offered. */
export function taken(repo: { slug: string; repo: string; takenBy?: string }): string {
  return (
    `A project called ${repo.repo} is already ${repo.takenBy}/${repo.repo}, and a project is keyed by its name, ` +
    `so onboarding ${repo.slug} would write onto that project's stream.`
  )
}

function settings(installation: Installation, label: string): Fix | null {
  return installation.htmlUrl === null ? null : { href: installation.htmlUrl, label }
}

/**
 * The installation a setup-URL return names, **if it is this App's** — or null.
 *
 * **`installation_id` on the setup URL is not trusted.** GitHub's own
 * documentation: *"Bad actors can hit this URL with a spoofed
 * `installation_id`"*. Its remedy is a user access token proving the
 * installation belongs to the person, and Lingtai has none — no user OAuth,
 * which [0045](../../../doc/decisions-archive/0045-one-team-one-conductor.md) names as
 * a separate epic. So it is checked against what the App itself reports:
 * `GET /app/installations/{id}` with the App's JWT answers 404 for any id that
 * is not one of this App's installations. Under one team and one conductor,
 * *an installation of our App* is the whole claim worth checking; and the id
 * is never acted on even then — it only says which installation to name first
 * on a screen that lists every one of them anyway.
 */
export async function verifiedInstallation(reader: AppReader, raw: string | null): Promise<number | null> {
  if (raw === null || !/^\d+$/.test(raw)) return null
  try {
    const installation = await reader.request<{ id: number }>('GET', `/app/installations/${raw}`, 'app')
    return installation.id
  } catch (err) {
    if (err instanceof GitHubFailed && err.status === 404) return null
    throw err
  }
}

/**
 * Where a return from GitHub's install screen goes: always the picker.
 *
 * **Everything in the query is optional**, `state` included — an
 * owner-approved install arrives with none. What the query can add is a
 * sentence: `installed` names a verified installation, and `requested` says an
 * organisation owner has been asked, which GitHub reports as
 * `setup_action=request` with no installation to name.
 */
export async function setupReturn(reader: AppReader, query: URLSearchParams): Promise<string> {
  const target = new URLSearchParams()
  if (query.get('setup_action') === 'request') {
    target.set('requested', '1')
  } else {
    let id: number | null = null
    try {
      id = await verifiedInstallation(reader, query.get('installation_id'))
    } catch {
      // GitHub would not answer. Nothing reads `installed` today but a
      // future screen that does would ask again anyway; a hint is not worth
      // failing the return for.
    }
    if (id !== null) target.set('installed', String(id))
  }
  const q = target.toString()
  return `/setup/repository${q === '' ? '' : `?${q}`}`
}
