import type { BuiltInSandbox } from '@lingtai/project'
import { WORKTREE_PLACEHOLDER } from '@lingtai/sandbox/policy'
import Link from 'next/link'
import type { ReactNode } from 'react'

import {
  agentsInSandbox,
  chipsOf,
  type AgentsInSandbox,
  legendOf,
  vendorGroupsOf,
  type Chip,
  type PathRoots,
} from '@/lib/sandbox-view'

/** What the recipe says in its `sandbox:` block, as the resolved recipe holds it; undefined where it has none. */
export interface OwnSandbox {
  readonly enabled: boolean
  readonly required: boolean
  readonly network: { readonly allow: readonly string[] }
  readonly write: readonly string[]
  readonly deny: readonly string[]
}

/** A row's source column: the recipe's file where it has entries for the row, else the built-ins. */
export function sourceOfRow(own: readonly string[]): '← recipe.yml' | '← built in' {
  return own.length > 0 ? '← recipe.yml' : '← built in'
}

const WORKTREE_MEANING = "each attempt's own, under <lingtai home>/worktrees/<project>/"

/** The recipe's own entries, drawn as written: they are the YAML's own spelling. */
function OwnChips({ entries }: { entries: readonly string[] }) {
  return (
    <>
      {entries.map((e) => (
        <span key={e} className="chip-code sbc-own" title={e}>
          {e}
        </span>
      ))}
    </>
  )
}

function BuiltInChip({ chip }: { chip: Chip }) {
  const short = chip.token !== null || chip.label === WORKTREE_PLACEHOLDER
  return (
    <span className={short ? 'chip-code sbc-short' : 'chip-code'} title={chip.fulls.join('\n')}>
      {chip.label}
    </span>
  )
}

function Sub({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="sbsub">
      <span className="sbsub-l">{label}</span>
      <span>{children}</span>
    </div>
  )
}

/** Which of the recipe's agents run inside the sandbox (#1329): the box, then one line per agent. */
function AgentsBlock({ agents, roots }: { agents: AgentsInSandbox; roots: PathRoots }) {
  return (
    <div className="sbagents">
      <div className="sbagents-h">which agents run inside it</div>
      <div className="sbagents-box">
        <span className="sbagents-boxl">SANDBOX — the worktree, the allowlisted hosts — no keys</span>
        {agents.inside.map((a) => (
          <span key={a.id} className="chip-code">
            {a.name}
          </span>
        ))}
      </div>
      {agents.outside.length === 0 ? null : (
        <div className="sbagents-out">
          {agents.outside.map((a) => (
            <span key={a.id} className="chip-code">
              {a.name}
            </span>
          ))}
          <span className="sbsent"> runs outside, with your keys</span>
        </div>
      )}
      {agents.inside.map((a) => {
        const adds = [
          ...(a.adds.hosts.length === 0 ? [] : [`reaches ${a.adds.hosts.join(', ')}`]),
          ...chipsOf(a.adds.writes, roots).map((c) => `writes ${c.label}`),
          ...(a.adds.hosts.length === 0 ? [] : ['its telemetry refused']),
        ]
        return (
          <p key={a.id} className="sbsent">
            {a.name} — inside · {a.signsIn}
            {adds.length === 0 ? '' : `; ${adds.join(', ')}`}
          </p>
        )
      })}
      {agents.outside.map((a) => (
        <p key={a.id} className="sbsent">
          {a.name} — {a.why}
        </p>
      ))}
      {agents.unknown.map((a) => (
        <p key={a.id} className="sbsent">
          {a.id} — {a.why}
        </p>
      ))}
    </div>
  )
}

function None({ href }: { href: string }) {
  return (
    <span className="sbnone">
      none <Link href={href}>Add one</Link>
    </span>
  )
}

function Row({ name, source, children }: { name: string; source: string; children: ReactNode }) {
  return (
    <div className="also">
      <span className="ak">{name}</span>
      <div>{children}</div>
      <small className="src">{source}</small>
    </div>
  )
}

/** A row of paths: this recipe's entries first, then the built-ins as chips. */
function PathsRow({
  name,
  own,
  chips,
  unknown,
  editHref,
  showOwn,
  extra,
}: {
  name: string
  own: readonly string[]
  chips: readonly Chip[] | null
  unknown: string | null
  editHref: string
  showOwn: boolean
  extra?: ReactNode
}) {
  return (
    <Row name={name} source={sourceOfRow(own)}>
      {showOwn ? (
        <Sub label="this recipe">{own.length === 0 ? <None href={editHref} /> : <OwnChips entries={own} />}</Sub>
      ) : null}
      {extra}
      {chips === null ? (
        <p className="fail sbsub-note">{unknown}</p>
      ) : (
        <Sub label="built in">
          {chips.map((c) => (
            <BuiltInChip key={c.label} chip={c} />
          ))}
        </Sub>
      )}
    </Row>
  )
}

/**
 * The recipe page's sandbox card (#1197): what the recipe configures, as rows beside *Also set*, and nothing a run met.
 * The task page's Sandbox tab says what a run ran under; a refused connection is acted on from there.
 */
export function SandboxSection({
  project,
  stamp,
  at,
  roots,
  own,
  recipeError,
  builtIn,
  runtimes = [],
}: {
  project: string
  /** The render's stamp for the editor link (`?r=`): what makes a second click a new command. Absent: no stamp. */
  stamp?: number
  /** The recipe's path, as the steps card names it. */
  at: string
  roots: PathRoots
  /** Undefined: no `sandbox:` block (off by choice), or the recipe could not be read (`recipeError`). */
  own: OwnSandbox | undefined
  recipeError: boolean
  builtIn: BuiltInSandbox
  /** `runtimesOf(recipe)`: the agents the recipe names. */
  runtimes?: readonly string[]
}) {
  const agents = recipeError ? null : agentsInSandbox(runtimes, own, roots.home)
  const addedHosts = [...new Set((agents?.inside ?? []).flatMap((a) => a.adds.hosts))]
  const addedWrites = [...new Set((agents?.inside ?? []).flatMap((a) => a.adds.writes))]
  const addedWriteChips = chipsOf(addedWrites, roots)
  const editHref = `/recipe/${encodeURIComponent(project)}?edit=1${stamp === undefined ? '' : `&r=${stamp}`}#sandbox`
  const paths = builtIn.paths
  const unknown = `the built-in paths could not be read${builtIn.pathsWhy === null ? '' : ` (${builtIn.pathsWhy})`}`
  const writable = paths === null ? null : chipsOf(paths.writable, roots)
  const denyRead = paths === null ? null : chipsOf(paths.denyRead, roots)
  const denyWrite = paths === null ? null : chipsOf(paths.denyWrite, roots)
  const hosts = vendorGroupsOf(builtIn.domains.map((host) => ({ host, source: 'built in' as const })))
  const legend = [
    ...legendOf([...(writable ?? []), ...(denyRead ?? []), ...(denyWrite ?? [])]).map((l) => ({
      token: l.token,
      meaning: l.paths.join(', '),
    })),
    ...(writable?.some((c) => c.label === WORKTREE_PLACEHOLDER)
      ? [{ token: WORKTREE_PLACEHOLDER, meaning: WORKTREE_MEANING }]
      : []),
  ]
  const reach = own?.network.allow ?? []
  return (
    <section className="rcard" id="sandbox">
      <h3 className="rcard-h">
        <span>Sandbox</span>
        <small className="src">← {at}</small>
      </h3>
      <p className="rcard-lede">
        What every run of an attempt may reach — the agents and the install and build commands alike. The merge is
        Lingtai&apos;s own and runs outside it.
      </p>
      {agents === null ? null : <AgentsBlock agents={agents} roots={roots} />}
      <Row name="state" source="← recipe.yml">
        {recipeError ? (
          <span className="sbsent">the recipe could not be read, so what it configures is unknown</span>
        ) : own === undefined ? (
          <>
            <span className="sbpill off">off</span>
            <span className="sbsent">
              {' '}
              off — no sandbox block. <Link href={editHref}>Add the block in the editor</Link>
            </span>
          </>
        ) : !own.enabled ? (
          <>
            <span className="sbpill off">off</span>
            <span className="sbsent"> off — enabled: false</span>
          </>
        ) : (
          <>
            <span className="sbpill on">on</span>
            <span className="sbsent">
              {own.required
                ? ' required — this project is refused on a host that cannot sandbox'
                : ' not required — on a host that cannot sandbox, runs go ahead unsandboxed and are marked'}
            </span>
          </>
        )}
      </Row>
      <Row name="reachable" source={sourceOfRow(reach)}>
        {recipeError ? null : (
          <Sub label="this recipe">{reach.length === 0 ? <None href={editHref} /> : <OwnChips entries={reach} />}</Sub>
        )}
        {addedHosts.length === 0 ? null : (
          <Sub label="copilot">
            {addedHosts.map((h) => (
              <span key={h} className="chip-code" title={h}>
                {h}
              </span>
            ))}
          </Sub>
        )}
        {hosts.vendors.map((v) => (
          <Sub key={v.vendor} label={v.vendor}>
            {v.hosts.map((h) => (
              <span key={h} className="chip-code" title={h}>
                {h}
              </span>
            ))}
          </Sub>
        ))}
      </Row>
      <PathsRow
        name="writable"
        own={own?.write ?? []}
        chips={writable}
        unknown={unknown}
        editHref={editHref}
        showOwn={!recipeError}
        extra={
          addedWriteChips.length === 0 ? null : (
            <Sub label="copilot">
              {addedWriteChips.map((c) => (
                <BuiltInChip key={c.label} chip={c} />
              ))}
            </Sub>
          )
        }
      />
      <PathsRow
        name="cannot be read"
        own={own?.deny ?? []}
        chips={denyRead}
        unknown={unknown}
        editHref={editHref}
        showOwn={!recipeError}
      />
      <Row name="cannot be written" source="← built in">
        {denyWrite === null ? (
          <p className="fail sbsub-note">{unknown}</p>
        ) : (
          <Sub label="built in">
            {denyWrite.map((c) => (
              <BuiltInChip key={c.label} chip={c} />
            ))}
          </Sub>
        )}
      </Row>
      {legend.length === 0 ? null : (
        <div className="rsblegend">
          {legend.map((l) => (
            <div key={l.token} className="rsblegend-r">
              <span className="rsblegend-n">{l.token}</span>
              <span className="rsblegend-m" title={l.meaning}>
                {l.meaning}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
