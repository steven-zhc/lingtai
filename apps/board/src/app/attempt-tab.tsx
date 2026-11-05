import { inWords } from '@lingtai/conductor/queue'
import { describeWaitLines } from '@lingtai/projector/task-view'

import { elapsed } from '@/lib/progress'
import { describeAction, readRecipe, type FromHead } from '@/lib/recipe'
import { billText } from '@/lib/spend'
import type { AttemptTabDetail, AttemptView } from '@/lib/task'

import { Evidence, RunDiff } from './evidence.tsx'
import { HistoryRow } from './history-row.tsx'
import { DocumentBody } from './markdown.tsx'
import { Segs } from './rail.tsx'
import { RunLog } from './run-log.tsx'
import { RawEvidence } from './standing.tsx'

/**
 * One attempt's tab: everything the record holds about it, in one place (#885,
 * 0118 §2). Before it, one attempt's diff, verdicts, prompt and steps were in
 * four tabs that each listed every attempt.
 *
 * In this order: one summary line; where it started and ended; **Steps**, the
 * rail and what each step said; the reasoning of the wait, only on the attempt
 * the page is deciding on; then five closed sections — Changes, Prompt, Recipe,
 * Run log and Events. They are closed and their content is in the page: that is
 * one attempt's, not every attempt's. Reading them only when opened is a later
 * ticket.
 */

/** Green is a run that ended well; red is one that did not; amber is neither yet. */
export function outcomeClass(state: AttemptView['outcome']['state']): string {
  if (state === 'failed') return 'fail'
  if (state === 'finished') return 'pass'
  return 'hold'
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function AttemptTab({ detail, now = Date.now() }: { detail: AttemptTabDetail; now?: number }) {
  const { run, standing, project } = detail
  const running = run.outcome.state === 'running'
  // The page is deciding on this attempt only while the ticket is blocked at it;
  // `deciding` is a search that walks back to an earlier refusal and means
  // nothing once the ticket has moved on.
  const deciding = standing.state === 'blocked' && standing.deciding?.attempt === run.attempt
  // Where the item is running and this is the attempt in flight, its log is the
  // page's rank 2 and this section says so rather than following the file twice.
  const followed = standing.state === 'running' && standing.runId === run.runId
  const proposed = run.baseSha !== null && run.headSha !== null

  // What the diagnosis said beyond rank 3's sentence: what was already done, and
  // the recommendation with the whole of its why.
  const beyond = deciding
    ? describeWaitLines({ diagnosis: standing.diagnosis }).filter((line) => line.part === 'did' || line.part === 'rec')
    : []

  return (
    <div className="atab" data-attempt={run.attempt}>
      <p className="asum">
        <span className={`pill ${outcomeClass(run.outcome.state)}`}>{run.outcome.state}</span>
        {run.outcome.detail ? <span className="adetail">{run.outcome.detail}</span> : null}
        <span className="afig">{run.turns === null ? '—' : `${run.turns} turns`}</span>
        <span className="afig">{run.durationMs === null ? '—' : elapsed(run.durationMs)}</span>
        <span className="afig">{billText(run.costUsd)}</span>
        <span className="afig">
          {run.diff === null ? '—' : `${run.diff.files}f +${run.diff.insertions} −${run.diff.deletions}`}
        </span>
        {/* Dated *and* relative. `04:12:15` alone cannot tell a run from three
            days ago apart from one ten minutes old (#102). */}
        <span className="aage" title={run.at}>
          {run.at.slice(0, 10)} · {inWords(now - Date.parse(run.at))} ago
        </span>
      </p>

      {/* The run id is in the title only: the tab is the attempt's name. */}
      <p className="ameta" title={run.runId}>
        {run.baseSha ? <span className="mono">base {run.baseSha.slice(0, 7)}</span> : null}
        {run.headSha ? <span className="mono">head {run.headSha.slice(0, 7)}</span> : null}
        {run.diff ? <span className="mono">{run.diff.branch}</span> : null}
      </p>

      <h3 className="asechead">Steps</h3>
      {/* All ten, always — including the ones nothing was configured at. A step
          that is merely omitted looks exactly like a step that was configured
          and silently did not run, and only one of those is our bug (ADR 0016
          §4, and 0061 §5 for the ten). Labelled, with nothing lit: where a run
          in flight is *now* is rank 2's to say, and this is the record. */}
      {run.progress === null ? (
        <p className="empty">Nothing is recorded for this attempt, so no step has been reached.</p>
      ) : (
        <div className="seq aseq">
          <Segs steps={run.progress.steps} at={null} labels />
        </div>
      )}
      {run.steps.length > 0 ? <Evidence steps={run.steps} /> : null}

      {deciding && standing.diagnosis?.raw?.trim() ? (
        <RawEvidence raw={standing.diagnosis.raw} said={standing.saidBy?.replace(':', ' / ') ?? null} />
      ) : null}
      {beyond.map((line) => (
        <p key={line.part} className="rhow">
          {line.text}
        </p>
      ))}

      <details className="asec">
        <summary>
          <span className="hdocname">Changes</span>
          <span className="hdocsize">{changesFact(run)}</span>
        </summary>
        {run.diff !== null && run.diff.files > 0 ? (
          <p>
            {plural(run.diff.files, 'file')}, +{run.diff.insertions} −{run.diff.deletions}
            {run.diff.branch !== '' ? `, on ${run.diff.branch}` : ''}
          </p>
        ) : null}
        {run.files.length > 0 ? (
          <ul className="flist">
            {run.files.map((f) => (
              <li key={f.path}>
                <span className="pill">{f.op}</span>
                <span className="fpath">{f.path}</span>
              </li>
            ))}
          </ul>
        ) : run.diff !== null && run.diff.files > 0 ? null : (
          <p className="empty">This attempt touched no files.</p>
        )}
        {/* Never `headSha ?? ''`: a run that never proposed anything has no
            commit to diff against (#417). The diff is read when the button is
            pressed. */}
        {proposed ? (
          <RunDiff
            key={`${run.baseSha}...${run.headSha}`}
            project={project}
            baseSha={run.baseSha!}
            headSha={run.headSha!}
          />
        ) : null}
      </details>

      <details className="asec aprompt">
        <summary>
          <span className="hdocname">Prompt</span>
          <span className="hdocsize" title={run.prompt?.version}>
            {run.prompt === null ? 'none recorded' : `${run.prompt.bytes} bytes`}
          </span>
        </summary>
        {run.prompt === null ? (
          <p className="empty">No prompt was recorded for this attempt.</p>
        ) : run.prompt.text === null ? (
          <p className="empty">
            This attempt predates the prompt being recorded, so the log has its length and not the document (#88).
          </p>
        ) : (
          // Raw, always. #88's justification is that the log holds the exact
          // document the agent was given; `markdown.tsx` offers the reading.
          <DocumentBody source="prompt" text={run.prompt.text} rawClass="hdoctext" />
        )}
      </details>

      <details className="asec">
        <summary>
          <span className="hdocname">Recipe</span>
          <span className="hdocsize">
            {run.recipe === undefined || run.recipe.of === 'none' ? 'not shown' : run.recipe.configHash.slice(0, 12)}
          </span>
        </summary>
        <RecipeGiven run={run} />
      </details>

      {/* `RunLog` is its own `<details>`: a second one around it would close
          under the reader when a run ends. A running attempt's opens with it and
          follows; every other stays closed and reads nothing (#110, #132). */}
      {followed ? (
        <p className="empty">Its run log is being followed at the top of this page.</p>
      ) : (
        <RunLog runId={run.runId} live={running} />
      )}

      <details className="asec">
        <summary>
          <span className="hdocname">Events</span>
          <span className="hdocsize">{detail.events.length}</span>
        </summary>
        {detail.events.length === 0 ? (
          <p className="empty">Nothing is on this attempt&apos;s stream.</p>
        ) : (
          <ol className="history">
            {detail.events.map((h) => (
              // Keyed by seq, which the store assigns and nothing reuses.
              <li key={h.seq}>
                <HistoryRow line={h} />
              </li>
            ))}
          </ol>
        )}
      </details>
    </div>
  )
}

function changesFact(run: AttemptView): string {
  if (run.diff !== null && run.diff.files > 0) return plural(run.diff.files, 'file')
  return run.files.length === 0 ? 'none touched' : plural(run.files.length, 'path')
}

/**
 * The recipe this attempt was given — the reading of it, what each of its gate
 * actions runs, and what differs from head (#190, #217).
 *
 * **On the attempt's tab, in its closed Recipe section.** An attempt's recipe is
 * a fact about that attempt, so it sits with the rest of that attempt's record
 * and not in a place of its own. It also puts the command beside the point it ran at, which was #190's whole argument:
 * the question is not *show me the recipe*, it is *what did `proposed:build`
 * do*, asked while looking at `proposed:build`.
 *
 * **Which recipe is said before anything from it is.** The one at head is what
 * the *next* run gets, and `.lingtai/config.yaml` moves; a command drawn under
 * this attempt's gates with nothing saying whose it is would be confidently
 * wrong about what ran. So the line leads: proved by this run's hash, or head's
 * and why this run's could not be had, or nothing and why.
 *
 * The names are the log's (`StepsResolved`, through `progress`), and only the
 * text is the recipe's. A point the log planned nothing at stays `skipped` and
 * grows no command (ADR 0016 §4); a name the shown recipe does not have says so
 * rather than borrowing a command from a different action.
 */
export function RecipeGiven({ run }: { run: AttemptView }) {
  const recipe = run.recipe
  if (recipe === undefined) return null
  if (recipe.of === 'none') {
    return <p className="empty arecipe">No recipe to show for this attempt: {recipe.why}.</p>
  }

  const hash = <span className="mono">recipe {recipe.configHash.slice(0, 12)}</span>
  return (
    <div className="arecipe">
      {recipe.of === 'run' ? (
        <p className="rprov">
          {hash} — this attempt&apos;s own, proved by the hash it recorded
          {'base' in recipe.at
            ? `, read at base ${recipe.at.base.slice(0, 7)}`
            : `, and the same document as the head of ${recipe.at.head}`}
        </p>
      ) : (
        <p className="rprov refusal">
          Not this attempt&apos;s recipe: {hash} is the head of {recipe.ref}, which is what the next attempt gets. Shown
          because {recipe.why}.
        </p>
      )}

      {/* The reading, in `lingtai status`'s rows and its words. Inside the
          Recipe section, which is closed: *what was this attempt run under*
          is answered by opening it, and the section's caption carries the hash. */}
      <dl className="rread">
        {readRecipe(recipe.recipe).map((row) => (
          <div key={row.name}>
            <dt>{row.name}</dt>
            <dd>{row.says}</dd>
          </div>
        ))}
      </dl>

      {/* **The record has the values and not the reasoning**, and a reader who
          takes a bare number for a number nobody argued about would be wrong
          about this repository, whose recipe explains `rounds` over seventy
          lines. 0047 §2 accepted that loss on purpose — `canonical` is the
          exact input `configHash` was taken over, and comments are not in it —
          so the page says it rather than letting the omission speak. */}
      <p className="rnote">
        Values only. What the log records is the canonical recipe — parsed, keys sorted, comments discarded (0047 §2) —
        so the reasoning behind a number here is in the recipe file and its history, not in the record.
      </p>

      {/* **Never `same` for a recipe that *is* head's.** "Nothing differs" is a
          claim about the attempt — it ran under what you have now — and that is
          exactly what the line above says could not be established. Shown as
          the absence of a comparison rather than as the result of one. */}
      {recipe.of === 'run' ? (
        <FromHeadSays from={recipe.from} />
      ) : (
        <p className="rdiff empty">
          This is the recipe at the head of {recipe.ref}, so there is nothing to compare it with: what this attempt was
          given could not be had.
        </p>
      )}

      {run.progress === null ? null : (
        <ol className="acts">
          {run.progress.steps.map((p) => (
            <li key={p.step}>
              <span className="actstep">{p.step}</span>
              {p.planned.length === 0 ? (
                <span className="empty">skipped</span>
              ) : (
                <span className="actlist">
                  {p.planned.map((name) => {
                    const action = recipe.recipe.steps[p.step].find((a) => a.name === name)
                    if (!action) {
                      return (
                        <span key={name} className="act">
                          <span className="mono">{name}</span> <span className="empty">not in this recipe</span>
                        </span>
                      )
                    }
                    const { does, bound } = describeAction(action, undefined, p.step)
                    return (
                      <details key={name} className="act">
                        <summary>
                          <span className="mono">{name}</span> <span className="actbound">{bound}</span>
                        </summary>
                        <pre className="actcmd">{does}</pre>
                      </details>
                    )
                  })}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}

      <details className="aprompt">
        <summary>
          <span className="hdocname">the whole recipe</span>
          <span className="hdocsize">{recipe.of === 'run' ? "this attempt's" : `head of ${recipe.ref}`}</span>
        </summary>
        <pre className="hdoctext">{recipe.source}</pre>
      </details>
    </div>
  )
}

/**
 * What this attempt's recipe has that the one at head does not (#217).
 *
 * **Said in all three cases, and *nothing differs* is the useful one.** Most of
 * the time this attempt ran under what you have now, and that is exactly what a
 * reader came to find out; a block that appeared only when something differed
 * would make silence mean two things — *the same* and *nobody looked* — and
 * `2d3353b` is the day that matters, when `pnpm test:db` left the `build` gate
 * and the runs from both sides of it sat in one list saying nothing.
 *
 * Not a disclosure of its own. It is the part that makes the Recipe section
 * worth opening, and the section is itself closed.
 */
function FromHeadSays({ from }: { from: FromHead }) {
  if (from.of === 'unknown') {
    return (
      <p className="rdiff empty">
        What differs from the recipe at head is not known: it could not be read — {from.why}.
      </p>
    )
  }
  if (from.of === 'same') {
    return (
      <p className="rdiff">
        Nothing differs from the recipe at the head of {from.ref}: this attempt ran under what you have now.
      </p>
    )
  }
  // **Never *0 values differ*.** The hash says these are two documents and the
  // walk is what names which values; where the walk can name none — two leaves
  // that read alike as strings — the difference is still real, and a heading
  // over an empty list would read as the page having nothing to say after
  // saying there was something.
  if (from.changes.length === 0) {
    return (
      <p className="rdiff refusal">
        This is not the recipe at the head of {from.ref}, and what differs is not a value this page can name: the two
        documents hash differently, so read the whole recipe below against head&apos;s.
      </p>
    )
  }
  return (
    <>
      <p className="rdiff refusal">
        This is not the recipe at the head of {from.ref} — {plural(from.changes.length, 'value')} differ
        {from.changes.length === 1 ? 's' : ''}:
      </p>
      <ul className="rchanges">
        {from.changes.map((c) => (
          <li key={c.path}>
            <span className="mono rpath">{c.path}</span>
            <span className="rran">{c.run ?? '(not set)'}</span>
            <span className="rhead">head: {c.head ?? '(not set)'}</span>
          </li>
        ))}
      </ul>
    </>
  )
}
