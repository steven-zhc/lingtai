import { loadProjects } from '@lingtai/conductor/projects'
import { notFound } from 'next/navigation'

import { Bar } from '@/app/bar.tsx'
import { projectRecipe, provenanceRows, sourceOf, underHome, type ProjectRecipe } from '@/lib/recipe'
import { recipeLines, type RecipeLine, type StepActionLine } from '@/lib/recipe-lines'

import { FooterFetched } from '../../footer-fetched'
import { StepRow } from '../../step-row'
import { RecipeText } from './recipe-text'

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
const COVERED = new Set(['picks up', 'excludes', 'an attempt', 'agent', 'assignee', 'retries', 'the steps'])

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

/**
 * The recipe read-only (#983): the ten steps in the order an attempt reaches
 * them, each with what it is for and what this recipe sets there, then what an
 * attempt may spend, then what no step owns. The file's own text is on the
 * right. The markup is written here and not imported from `setup-form.tsx`,
 * which reaches a server-action module this page must not follow beyond the
 * editor's own.
 */
function LeftColumn({ view }: { view: Extract<ProjectRecipe, { ok: true }> }) {
  const read = recipeLines(view.recipe, view.ref)
  const stepsRow = view.rows.find((row) => row.name === 'the steps')
  const source = stepsRow === undefined ? 'not said' : (sourceOf(stepsRow, view.provenance) ?? 'not said')
  return (
    <div className="s2-left">
      <section className="rcard">
        <h3 className="rcard-h">
          <span>What one attempt does, in order</span>
          <small className="src">← {source}</small>
        </h3>
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
            <b>{read.limits.rounds}</b>
            <span>rounds</span>
          </div>
          <div className="stat">
            <b>{read.limits.restarts}</b>
            <span>restarts</span>
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
export function Recipe({ view, edit = false }: { view: ProjectRecipe; edit?: boolean }) {
  const text = view.text
  return (
    <>
      <main className="detail">
        <Bar project={view.project}>
          <span className="sep" />
          <span className="mono">recipe · {view.project}</span>
        </Bar>

        <div className="detail-body">
          <section>
            <h2>
              <span className="hlab">Recipe</span>
              {/* The hash and the branch, so a reader can hold this against an
                attempt's on the task page — which is the comparison that
                matters on the day they differ (#217). */}
              <span className="hfact">
                {view.ok
                  ? `recipe ${view.configHash.slice(0, 12)} · base ${view.ref} — what the next attempt gets`
                  : view.fault === 'recipe'
                    ? 'it could not be read, so nothing will be taken from this project'
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
            <div className={view.ok ? 's2' : undefined}>
              {view.ok ? <LeftColumn view={view} /> : null}
              <div className="s2-right">
                {text === null ? null : <RecipeText project={view.project} text={text} open={edit || !view.ok} />}
              </div>
            </div>
          </section>

          {view.ok ? (
            /* `lingtai doctor`'s own block, which has printed since #180 and
               which no surface with a screen had shown. Folded: exhaustive
               where it is grouped — `repo.base` and `env.required` are here
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
  searchParams: Promise<{ edit?: string | string[] }>
}) {
  const { project } = await params
  const { edit } = await searchParams
  const name = decodeURIComponent(project)
  // Registered only: a repository that is recorded and not yet conducted has no
  // recipe to resolve, and `notFound` is the honest answer for a name nothing
  // here has heard of.
  const state = (await loadProjects()).find((p) => p.project === name)
  if (state === undefined) notFound()
  return <Recipe view={await projectRecipe(state)} edit={edit === '1'} />
}
