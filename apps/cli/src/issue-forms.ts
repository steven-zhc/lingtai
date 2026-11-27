/**
 * A repository's issue forms (#1518): what `NEXT`'s first-ticket step opens instead of
 * `gh issue create`, whose picker lists no form from GraphQL's `issueTemplates`.
 *
 * Only `.yml`/`.yaml` files under `.github/ISSUE_TEMPLATE` other than `config.*` are forms.
 * Every read here answers `none` when it fails, and never fails the command that asked.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { GithubReach } from '@lingtai/conductor/onboard'
import { Effect } from 'effect'
import { parse } from 'yaml'

import { liveLabelClient } from './add-labels.ts'
import { lift } from './exit.ts'

export type IssueForms = { kind: 'none' } | { kind: 'one'; file: string; name: string } | { kind: 'several' }

export const NO_FORMS: IssueForms = { kind: 'none' }

const FORMS_DIR = '.github/ISSUE_TEMPLATE'

/** The forms among a directory's file names: `.yml`/`.yaml`, never `config.yml`/`config.yaml`. */
export function formFiles(listing: readonly string[]): string[] {
  return listing.filter((n) => /\.ya?ml$/i.test(n) && !/^config\.ya?ml$/i.test(n))
}

/** The form's `name:`, or null when the text is not YAML or names nothing. */
function nameOf(text: string): string | null {
  try {
    const doc: unknown = parse(text)
    const name = typeof doc === 'object' && doc !== null ? (doc as { name?: unknown }).name : undefined
    return typeof name === 'string' && name.trim() !== '' ? name : null
  } catch {
    return null
  }
}

/**
 * `listing` is the directory's file names; `onlyFormText` is the one form's text, read only
 * when exactly one form is in it (see `formFiles`). A name that cannot be read is `none`.
 */
export function issueFormsOf(listing: readonly string[], onlyFormText: string | null): IssueForms {
  const files = formFiles(listing)
  if (files.length > 1) return { kind: 'several' }
  const file = files[0]
  if (file === undefined || onlyFormText === null) return NO_FORMS
  const name = nameOf(onlyFormText)
  return name === null ? NO_FORMS : { kind: 'one', file, name }
}

/** From the checkout, with no network: whatever the checked-out branch has. */
export const checkoutIssueForms = (toplevel: string): Effect.Effect<IssueForms> =>
  Effect.try(() => {
    const dir = join(toplevel, FORMS_DIR)
    const listing = readdirSync(dir)
    const files = formFiles(listing)
    const only = files.length === 1 ? readFileSync(join(dir, files[0]!), 'utf8') : null
    return issueFormsOf(listing, only)
  }).pipe(Effect.catchCause(() => Effect.succeed(NO_FORMS)))

/** From the repository's default branch: one request, and a second when exactly one form is there. */
export const githubIssueForms = (owner: string, repo: string, reach: GithubReach): Effect.Effect<IssueForms> =>
  Effect.gen(function* () {
    const client = yield* liveLabelClient(owner, repo, reach)
    const base = `/repos/${owner}/${repo}/contents/${FORMS_DIR}`
    const entries = yield* lift(() => client.request<{ name: string; type?: string }[]>('GET', base))
    const listing = Array.isArray(entries) ? entries.filter((e) => e.type !== 'dir').map((e) => e.name) : []
    const files = formFiles(listing)
    if (files.length !== 1) return issueFormsOf(listing, null)
    const file = yield* lift(() =>
      client.request<{ content?: string }>('GET', `${base}/${encodeURIComponent(files[0]!)}`),
    )
    const text = typeof file.content === 'string' ? Buffer.from(file.content, 'base64').toString('utf8') : null
    return issueFormsOf(listing, text)
  }).pipe(Effect.catchCause(() => Effect.succeed(NO_FORMS)))
