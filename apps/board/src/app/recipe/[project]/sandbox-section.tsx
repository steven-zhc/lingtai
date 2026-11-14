import type { BuiltInSandbox } from '@lingtai/recipe'
import Link from 'next/link'
import type { ReactNode } from 'react'

import { RECENT_DAYS } from '@/lib/sandbox-view'

/** What the recipe says in its `sandbox:` block, as the resolved recipe holds it; undefined where it has none. */
export interface OwnSandbox {
  readonly enabled: boolean
  readonly required: boolean
  readonly network: { readonly allow: readonly string[] }
  readonly write: readonly string[]
  readonly deny: readonly string[]
}

function Entries({ title, own, builtIn }: { title: string; own: readonly string[]; builtIn: readonly string[] }) {
  return (
    <>
      <p className="sbhead">{title}</p>
      <ul className="mono">
        {own.map((e) => (
          <li key={`own:${e}`}>
            {e} <span className="empty">this recipe</span>
          </li>
        ))}
        {builtIn.map((e) => (
          <li key={`built:${e}`} className="empty">
            {e} <span>built in</span>
          </li>
        ))}
        {own.length + builtIn.length === 0 ? <li className="empty">none</li> : null}
      </ul>
    </>
  )
}

/**
 * The recipe page's sandbox section (#1162): *configured now* — the recipe's own `network.allow`, `write` and `deny`
 * beside the built-ins, which are greyed and carry no remove, since they are not in the YAML — and *recently blocked*
 * from every task of the project. The task page's Sandbox tab says what a run *ran under*; this says what the recipe
 * says today. `blocked` is a slot so this stays pure: the page hands it the loaded, Suspense-wrapped part.
 */
export function SandboxSection({
  project,
  own,
  recipeError,
  builtIn,
  blocked,
}: {
  project: string
  /** Undefined: no `sandbox:` block (off by choice), or the recipe could not be read (`recipeError`). */
  own: OwnSandbox | undefined
  recipeError: boolean
  builtIn: BuiltInSandbox
  blocked: ReactNode
}) {
  const editHref = `/recipe/${encodeURIComponent(project)}?edit=1#sandbox`
  const state = recipeError
    ? 'the recipe could not be read, so what it configures is unknown'
    : own === undefined
      ? 'off — no sandbox block'
      : own.enabled
        ? `on${own.required ? ', required' : ''}`
        : 'off — enabled: false'
  const paths = builtIn.paths
  return (
    <section className="rcard" id="sandbox">
      <h3 className="rcard-h">
        <span>Sandbox</span>
        <small className="src">configured now</small>
      </h3>
      <p className="rcard-lede">
        What this recipe says today: {state}. The task page&apos;s Sandbox tab says what a run ran under.
      </p>
      {own === undefined && !recipeError ? (
        <p>
          A recipe with no <span className="mono">sandbox:</span> block runs unsandboxed. The built-ins below are what
          turning it on would give. <Link href={editHref}>Add the block in the editor</Link>.
        </p>
      ) : null}
      <Entries title="Reachable" own={own?.network.allow ?? []} builtIn={builtIn.domains} />
      {paths === null ? (
        <p className="fail">
          The built-in paths could not be read{builtIn.pathsWhy === null ? '' : ` (${builtIn.pathsWhy})`}, so they are
          not listed.
        </p>
      ) : (
        <>
          <Entries title="Writable" own={own?.write ?? []} builtIn={paths.writable} />
          <Entries title="Cannot be read" own={own?.deny ?? []} builtIn={paths.denyRead} />
          <Entries title="Cannot be written" own={[]} builtIn={paths.denyWrite} />
        </>
      )}
      <h3 className="rcard-h">
        <span>Recently blocked</span>
        <small className="src">every task of this project, the last {RECENT_DAYS} days</small>
      </h3>
      {blocked}
    </section>
  )
}
