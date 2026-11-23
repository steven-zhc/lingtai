import { homedir } from 'node:os'

import { hasGitHubAuth, stateDir } from '@lingtai/env'
import { builtInSandboxEffect } from '@lingtai/project'
import { branchOf, runtimesOf } from '@lingtai/recipe'
import { Effect } from 'effect'
import { notFound } from 'next/navigation'
import { type ReactNode } from 'react'

import { Bar, BarActions } from '@/app/bar.tsx'
import { LockBanner, pauseSlot } from '@/app/lock-banner.tsx'
import { PlaceLine, viewsFor, type PlaceView } from '@/app/place-line.tsx'
import { ModeGraph } from '@/components/mode-graph.tsx'
import { filterOptions, onBoardProjects } from '@/lib/board'
import { lockMap } from '@/lib/lock-marks.ts'
import { readProjectLocks, readRegistered } from '@/lib/locks.ts'
import { placeViewsOf } from '@/lib/prs.ts'
import { projectRecipe, provenanceRows, sourceOf, underHome, type ProjectRecipe } from '@/lib/recipe'
import { modeLines, modeSource, recipeLines, type RecipeLine, type StepActionLine } from '@/lib/recipe-lines'
import { sandboxStates } from '@/lib/sandbox-state.ts'

import { FooterFetched } from '../../footer-fetched'
import { StepRow } from '../../step-row'
import { RecipeBar, type RecipeBarFilter } from './recipe-bar'
import { RecipeText, type AllowRequest } from './recipe-text'
import { SandboxSection } from './sandbox-section'

/**
 * What one project's recipe says today, and which file each value came from
 * (#218).
 *
 * **The view the bar pointed at.** the-bar.md moved `<project>: rounds ×N` off
 * the row *to the recipe view*, and the reasoning was right — a setting that
 * changes about once a quarter does not belong on a rail read in a glance — but
 * the destination did not exist, so the fact left the board and arrived
 * nowhere. This is where it arrived.
 *
 * **And the board is the only surface that can carry it.**
 * [0046](../../../../../doc/decisions-archive/0046-lingtai-is-personal.md) §3 moved the
 * recipe to `~/.lingtai/<project>/recipe.yml` and recorded the cost in its own
 * words: nothing in the repository says Lingtai is in use, and a file under a
 * home directory is not discoverable by cloning. A page is.
 *
 * **Viewing and editing are one page (#980).** The right column holds the
 * file's text and an *Edit* on it that turns the text into the editor in place
 * (`?edit=1` opens it); a recipe that will not parse opens it too, so it can be
 * repaired here. The writer is still one place: `app/actions.ts`'s `saveRecipe`
 * ([0125](../../../../../doc/decisions/0125-setup-is-one-module-two-inputs.md)
 * §6, #973), reached from `recipe-form.tsx` alone. `recipe.test.tsx` reads this
 * segment's whole tree as text and fails on an exported handler, a `route.ts`,
 * a write, or a second server module imported from here — the tree and not
 * this file, because a `page.tsx` serves no method anyway.
 */
export const dynamic = 'force-dynamic'

/** Rows a step block already says, so *Also set* is what no step owns. */
const COVERED = new Set(['picks up', 'excludes', 'an attempt', 'agent', 'assignee', 'retries', 'the steps', 'budget'])

const MUTED = new Set(['nothing', 'none'])

/** A setting's value: chips for a list, code for a command, muted for an empty answer. */
function Value({ line }: { line: RecipeLine }) {
  if (line.chips !== undefined) {
    return (
      <span className="sv">
        {line.chips.map((chip) => (
          <span className="chip-kind" key={chip}>
            {chip}
          </span>
        ))}
      </span>
    )
  }
  if (MUTED.has(line.value)) return <span className="step-q">{line.value}</span>
  if (line.label === 'tickets' || line.label === 'base' || line.label === 'agent') {
    return <span className="step-mono">{line.value}</span>
  }
  return <span>{line.value}</span>
}

function Action({ action }: { action: StepActionLine }) {
  if (action.when !== null) {
    return (
      <div className="step-when">
        <span>
          {action.label}
          {action.value === null ? null : <span className="step-mono"> {action.value}</span>}
        </span>
        <small>when {action.when}</small>
      </div>
    )
  }
  return (
    <div className="step-set">
      <span>{action.label}</span>
      {action.value === null ? (
        <span />
      ) : action.code ? (
        <span className="sv">
          <span className="chip-code">{action.value}</span>
        </span>
      ) : (
        <span className="step-mono">{action.value}</span>
      )}
    </div>
  )
}

/** The mode, first (#1326): a reading of the resolved recipe, never of the log. */
export function ModeCard({ recipe }: { recipe: Extract<ProjectRecipe, { ok: true }>['recipe'] }) {
  const mode = modeLines(recipe)
  return (
    <section className="rcard" id="mode">
      <h3 className="rcard-h">
        <span>Mode · {mode.mode}</span>
        <small className="src">← {modeSource(recipe)}</small>
      </h3>
      <ModeGraph mode={mode.mode} main={mode.main} personal={mode.personal} />
      {mode.named ? null : (
        <p className="rcard-lede">No mode in the recipe reads as solo, so a project made before 0.16 runs as it did.</p>
      )}
      {mode.lines.map((line) => (
        <div className="step-set" key={line.label}>
          <span className="step-set-k">{line.label}</span> <span>{line.says}</span>
        </div>
      ))}
      {mode.pr === null ? null : (
        <div className="step-set">
          <span className="step-set-k">PR</span>{' '}
          <span>
            summary · <span className="mono">{mode.pr.agent}</span>
            {mode.pr.agentFromDefault ? ' ← runtime.agent' : ''} · {mode.pr.turns} turns · {mode.pr.wall}
            {mode.pr.fromDefault ? ' ← default' : ''}
          </span>
        </div>
      )}
      {mode.pr === null ? null : (
        <div className="step-set">
          <span className="step-set-k">CI</span>{' '}
          <span>
            {mode.pr.ci.provider === 'detect'
              ? 'detect (a pull_request workflow means GitHub Actions)'
              : mode.pr.ci.provider}
            {mode.pr.ci.from.provider === 'default' ? ' ← default' : ' ← recipe.yml'} ·{' '}
            {mode.pr.ci.required === 'all' ? 'every check' : mode.pr.ci.required.join(', ')}
            {mode.pr.ci.from.required === 'default' ? ' ← default' : ' ← recipe.yml'} · {mode.pr.ci.timeout}
            {mode.pr.ci.from.timeout === 'default' ? ' ← default' : ' ← recipe.yml'}
          </span>
        </div>
      )}
    </section>
  )
}

/**
 * The recipe read-only (#983): the ten steps in the order an attempt reaches
 * them, each with what it is for and what this recipe sets there, then what an
 * attempt may spend, then what no step owns. The file's own text is on the
 * right. The markup is written here and not imported from `setup-form.tsx`,
 * which reaches a server-action module this page must not follow beyond the
 * editor's own.
 */
function LeftColumn({ view, sandbox }: { view: Extract<ProjectRecipe, { ok: true }>; sandbox?: ReactNode }) {
  const read = recipeLines(view.recipe, view.ref)
  const stepsRow = view.rows.find((row) => row.name === 'the steps')
  const source = stepsRow === undefined ? 'not said' : (sourceOf(stepsRow, view.provenance) ?? 'not said')
  return (
    <div className="s2-left">
      <ModeCard recipe={view.recipe} />
      <section className="rcard">
        <h3 className="rcard-h">
          <span>What one attempt does, in order</span>
          <small className="src">← {source}</small>
        </h3>
        <p className="rcard-lede">The ten steps and their order never change. What each one runs is yours.</p>
        <ol className="step-list">
          {read.steps.map((block, i) => (
            <StepRow
              key={block.step}
              n={i + 1}
              step={block.step}
              says={block.says}
              on={block.settings.length > 0 || block.actions.length > 0}
            >
              {block.settings.map((line) => (
                <div className="step-set" key={line.label}>
                  <span>{line.label}</span>
                  <Value line={line} />
                </div>
              ))}
              {block.actions.map((action, j) => (
                <Action action={action} key={`${action.label}-${j}`} />
              ))}
              {block.after.map((line) => (
                <div className="step-set" key={line.label}>
                  <span>{line.label}</span>
                  <Value line={line} />
                </div>
              ))}
            </StepRow>
          ))}
        </ol>
      </section>

      <section className="rcard">
        <h3 className="rcard-h">
          <span>What an attempt may spend</span>
        </h3>
        <div className="stats">
          <div className="stat">
            <b>{read.limits.refusalFixes}</b>
            <span>fixes after a refusal, in the same worktree</span>
          </div>
          <div className="stat">
            <b>{read.limits.conflictResolutions}</b>
            <span>merge conflict resolutions</span>
          </div>
          <div className="stat">
            <b>{read.limits.newAttempts}</b>
            <span>new attempts from the base</span>
          </div>
          <div className="stat">
            <b>{read.limits.wall}</b>
            <span>wall</span>
          </div>
          <div className="stat">
            <b>{read.limits.turns}</b>
            <span>turns</span>
          </div>
        </div>
        <p className="say">{read.ceiling}</p>
      </section>

      <section className="rcard">
        <h3 className="rcard-h">
          <span>Also set</span>
        </h3>
        {view.rows
          .filter((row) => !COVERED.has(row.name))
          .map((row) => (
            <div className="also" key={row.name}>
              <span className="ak">{row.name}</span>
              <span>{row.says}</span>
              <small className="src">← {sourceOf(row, view.provenance) ?? 'not said'}</small>
            </div>
          ))}
      </section>

      {sandbox}
    </div>
  )
}

/**
 * The page, as a reducer over its answer.
 *
 * Exported and pure so the claims that matter — every row names a source, a
 * recipe that will not parse names the file and the fault, nothing here writes
 * — are assertable without a database or a `~/.lingtai/`.
 */
export function Recipe({
  view,
  edit = false,
  bar,
  views,
  pause,
  banner,
  sandbox,
  allow,
  nav,
}: {
  view: ProjectRecipe
  edit?: boolean
  bar?: RecipeBarFilter
  /** The place line's views, read by the page (a team project has `PRs`, #1319): this stays pure. */
  views?: PlaceView[]
  /** The bar's Pause button and the row under it, built by the page that read the locks (#994): this stays pure. */
  pause?: ReactNode
  banner?: ReactNode
  /** The sandbox section (#1162), built by the page that read the log and the host: this stays pure. */
  sandbox?: ReactNode
  /** A request to add a host to the editor's draft. Its `nonce` is the URL's stamp, so only a new click is a new request. */
  allow?: AllowRequest
  /** The URL's stamp (`?r=`): what tells a click on a link from a re-render of the same page. */
  nav?: number
}) {
  const text = view.text
  return (
    <>
      <main className="detail">
        {bar === undefined ? (
          <Bar
            project={view.project}
            here="recipe"
            actions={<BarActions project={view.project} here="recipe" pause={pause} recipe={false} />}
          >
            <PlaceLine project={view.project} views={views ?? viewsFor(view.project)} here="recipe" />
          </Bar>
        ) : (
          <RecipeBar project={view.project} {...bar} {...(views === undefined ? {} : { views })} pause={pause} />
        )}
        {banner}

        <div className="detail-body detail-body-wide">
          <section>
            <h2>
              <span className="hlab">Recipe</span>
              {/* The hash and the branch, so a reader can hold this against an
                attempt's on the task page — which is the comparison that
                matters on the day they differ (#217). */}
              <span className="hfact">
                {view.ok
                  ? view.recipe.mode === 'team'
                    ? `recipe ${view.configHash.slice(0, 12)} · main ${view.recipe.branch.main} · yours ${branchOf(view.recipe)} — what the next attempt gets`
                    : `recipe ${view.configHash.slice(0, 12)} · base ${view.ref} — what the next attempt gets`
                  : view.fault === 'recipe'
                    ? 'it could not be read, so nothing will be taken from this project'
                    : view.fault === 'refused'
                      ? 'it was refused, so nothing will be taken from this project'
                      : 'it could not be resolved, so nothing will be taken from this project'}
              </span>
            </h2>

            {view.ok ? null : (
              /* Named, never an empty page: a recipe that will not parse is the
               failure that cost this project a whole queue while every surface
               rendered as though there were simply nothing to do (#76).

               And the file named is the one at fault. `gates:` in the machine
               file, a `runtime.assignee` written there since it moved to the
               recipe (#373), and two runtimes signed in with nothing naming
               one all stop this resolve with the recipe perfectly readable;
               a page that said *the recipe could not be read* would have its
               reader open that file twice over and find nothing wrong, while
               the one to edit went unnamed. */
              <p className="refusal">
                {view.fault === 'recipe' ? (
                  <>
                    The recipe at <span className="mono">{underHome(view.at)}</span> could not be read: {view.problem}.
                  </>
                ) : view.fault === 'refused' ? (
                  <>recipe refused — {view.problem}</>
                ) : (
                  <>
                    The recipe was not resolved, and the fault is in this machine&apos;s{' '}
                    <span className="mono">{underHome(view.at)}</span> rather than in the recipe: {view.problem}.
                  </>
                )}
              </p>
            )}

            {/* One structure for both states, so a repair that makes the recipe
                resolve re-renders the editor in place rather than remounting it
                and dropping the message the save just earned. Without `.s2` the
                broken case sits below the refusal. */}
            <div className={view.ok ? 's2 s2-even' : undefined}>
              {view.ok ? <LeftColumn view={view} sandbox={sandbox} /> : null}
              <div className="s2-right">
                {text === null ? null : (
                  <RecipeText
                    project={view.project}
                    text={text}
                    open={edit || !view.ok || allow !== undefined}
                    path={underHome(view.at)}
                    {...(allow === undefined ? {} : { allow })}
                    {...(nav === undefined ? {} : { nav })}
                  />
                )}
              </div>
            </div>
            {/* A recipe that will not resolve has no left column; the built-ins still show, under the refusal. */}
            {view.ok ? null : sandbox}
          </section>

          {view.ok ? (
            /* `lingtai doctor`'s own block, which has printed since #180 and
               which no surface with a screen had shown. Folded: exhaustive
               where it is grouped — `branch.main` and `env.required` are here
               and in no line above — and longer than anyone reads. */
            <details>
              <summary>Where every value came from</summary>
              <p className="hfact">
                the recipe at <span className="mono">{underHome(view.at)}</span>, this machine&apos;s{' '}
                <span className="mono">config.yml</span>, the preset it <span className="mono">extends</span>,
                detection, or a default
              </p>
              <ul className="prov">
                {provenanceRows(view.provenance).map((row) => (
                  <li key={row.key}>
                    <span className="rpath mono">{row.key}</span>
                    <span className="pval">{row.value}</span>
                    <span className="rfrom">← {row.from}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </main>
      <FooterFetched />
    </>
  )
}

export default async function RecipePage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>
  searchParams: Promise<{ edit?: string | string[]; allow?: string | string[]; r?: string | string[] }>
}) {
  const { project } = await params
  const { edit, allow, r } = await searchParams
  const name = decodeURIComponent(project)
  // Registered only: a repository that is recorded and not yet conducted has no
  // recipe to resolve, and `notFound` is the honest answer for a name nothing
  // here has heard of.
  // A failed read is said under the bar (#994) and not thrown: the banner reads
  // the same cached rejection and draws "could not read which projects are paused".
  let projects: Awaited<ReturnType<typeof readRegistered>>
  try {
    projects = await readRegistered()
  } catch {
    return (
      <main className="detail">
        <Bar project={name} here="recipe">
          <PlaceLine project={name} views={viewsFor(name)} here="recipe" />
        </Bar>
        <LockBanner project={name} />
      </main>
    )
  }
  const state = projects.find((p) => p.project === name)
  if (state === undefined) notFound()
  const registered = projects.map((p) => p.project).filter((p): p is string => p !== null)
  // The board's projection failing must not take the recipe page with it.
  const onBoard = await onBoardProjects().catch(() => [] as string[])
  const bar = {
    filters: filterOptions(registered, onBoard),
    registered,
    app: hasGitHubAuth(),
    locks: lockMap(await readProjectLocks()),
    sandbox: sandboxStates(projects),
  }
  const view = await projectRecipe(state)
  const builtIn = await Effect.runPromise(builtInSandboxEffect(name))
  // `?allow=<host>`: a request the editor applies to its own current draft, so earlier unsaved edits survive; it is
  // never saved from here, and never judged against the disk text (what the draft already holds is the form's to say).
  // `?r=` is stamped on the links when they render and is read back from the URL, so a save's revalidation, which
  // keeps the URL, is not a second click, and the next render's links carry a new stamp, so the next click is.
  const stamp = Date.now()
  const parsedNav = typeof r === 'string' ? Number(r) : 0
  const nav = Number.isFinite(parsedNav) ? parsedNav : 0
  const host = typeof allow === 'string' ? allow : undefined
  const request: AllowRequest | null = host === undefined || view.text === null ? null : { host, nonce: nav }
  return (
    <Recipe
      view={view}
      edit={edit === '1'}
      nav={nav}
      {...(request === null ? {} : { allow: request })}
      sandbox={
        <SandboxSection
          project={name}
          stamp={stamp}
          own={view.ok ? view.recipe.sandbox : undefined}
          recipeError={!view.ok}
          runtimes={view.ok ? runtimesOf(view.recipe) : []}
          builtIn={builtIn}
          at={underHome(view.at)}
          roots={{ home: homedir(), lingtaiHome: stateDir(), project: name }}
        />
      }
      bar={bar}
      views={await placeViewsOf(name)}
      pause={await pauseSlot(name)}
      banner={<LockBanner project={name} />}
    />
  )
}
