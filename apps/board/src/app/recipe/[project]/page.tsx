import Link from "next/link";
import { notFound } from "next/navigation";
import { loadProjects } from "@lingtai/conductor/projects";
import {
  projectRecipe,
  provenanceRows,
  sourceOf,
  underHome,
  type ProjectRecipe,
} from "@/lib/recipe";

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
 * [0046](../../../../../doc/decisions/0046-lingtai-is-personal.md) §3 moved the
 * recipe to `~/.lingtai/<project>/recipe.yml` and recorded the cost in its own
 * words: nothing in the repository says Lingtai is in use, and a file under a
 * home directory is not discoverable by cloning. A page is.
 *
 * **Read-only, and that is not fastidiousness.** 0046 §4 retired `tamper` on
 * one sentence — with the recipe in `~/.lingtai/`, an agent cannot reach it, so
 * the guard has nothing left to guard. A board that could *write* the recipe
 * would be a process that can write it, reachable over HTTP from the machine an
 * agent runs on, and that argument would have to be made again. Reading changes
 * nothing about reach; writing does. Editing is #206's, and it is where the
 * question belongs.
 *
 * So there is nothing here to press and no way to post. `recipe.test.tsx` reads
 * this segment's whole tree as text — and the modules the page imports — and
 * fails on an exported handler, a server directive or a write, as well as on
 * the rendered markup. The tree and not this file: a `page.tsx` serves no
 * method anyway, and what would actually make this route a writer is a
 * `route.ts` in a segment under it, or a server-action module imported from
 * here. *Nothing writes* is a claim about the route, not about what today's
 * markup happens to contain.
 */
export const dynamic = "force-dynamic";

/**
 * The page, as a fold over its answer.
 *
 * Exported and pure so the claims that matter — every row names a source, a
 * recipe that will not parse names the file and the fault, nothing here writes
 * — are assertable without a database or a `~/.lingtai/`.
 */
export function Recipe({ view }: { view: ProjectRecipe }) {
  const back = `/?project=${encodeURIComponent(view.project)}`;
  return (
    <main className="detail">
      <div className="bar">
        <Link className="brand" href={back}>
          ← Lingtai
        </Link>
        <span className="sep" />
        <span className="mono">recipe · {view.project}</span>
      </div>

      <div className="detail-body">
        <section>
          <h2>
            <span className="hlab">Recipe</span>
            {/* The hash and the branch, so a reader can hold this against an
                attempt's on the task page — which is the comparison that
                matters on the day they differ (#217). */}
            <span className="hfact">
              {view.ok
                ? `recipe ${view.configHash.slice(0, 12)} · base ${view.ref} — what the next run gets`
                : view.fault === "recipe"
                  ? "it could not be read, so nothing will be taken from this project"
                  : "it could not be resolved, so nothing will be taken from this project"}
            </span>
          </h2>

          {view.ok ? (
            /* `lingtai status`'s rows, in `lingtai status`'s words, and one
               column it does not have: where the value came from. Two files
               decide one project and `provenance` is the only thing that says
               which of them won. */
            <dl className="rread sourced">
              {view.rows.map((row) => (
                <div key={row.name}>
                  <dt>{row.name}</dt>
                  <dd>{row.says}</dd>
                  <dd className="rfrom">← {sourceOf(row, view.provenance) ?? "not said"}</dd>
                </div>
              ))}
            </dl>
          ) : (
            /* Named, never an empty page: a recipe that will not parse is the
               failure that cost this project a whole queue while every surface
               rendered as though there were simply nothing to do (#76).

               And the file named is the one at fault. `gates:` in the machine
               file, an ill-formed `runtime.assignee` and two runtimes signed
               in with nothing naming one all stop this resolve with the recipe
               perfectly readable; a page that said *the recipe could not be
               read* would have its reader open that file twice over and find
               nothing wrong, while the one to edit went unnamed. */
            <p className="refusal">
              {view.fault === "recipe" ? (
                <>
                  The recipe at <span className="mono">{underHome(view.at)}</span> could not be read:{" "}
                  {view.problem}.
                </>
              ) : (
                <>
                  The recipe was not resolved, and the fault is in this machine&apos;s{" "}
                  <span className="mono">{underHome(view.at)}</span> rather than in the recipe:{" "}
                  {view.problem}.
                </>
              )}
            </p>
          )}
        </section>

        {view.ok ? (
          <section>
            <h2>
              <span className="hlab">Where every value came from</span>
              <span className="hfact">
                the recipe at <span className="mono">{underHome(view.at)}</span>, this machine&apos;s{" "}
                <span className="mono">config.yml</span>, the preset it{" "}
                <span className="mono">extends</span>, detection, or a default
              </span>
            </h2>
            {/* `lingtai doctor`'s own block, which has printed since #180 and
                which no surface with a screen has ever shown. Longer than the
                reading and exhaustive where it is grouped — `repo.base` and
                `env.required` are here and in no row above. */}
            <ul className="prov">
              {provenanceRows(view.provenance).map((row) => (
                <li key={row.key}>
                  <span className="rpath mono">{row.key}</span>
                  <span className="pval">{row.value}</span>
                  <span className="rfrom">← {row.from}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <p className="rnote">
          Read-only. Nothing on this page writes the recipe, and that is the point rather than an
          omission: 0046 §4 retired <span className="mono">tamper</span> because the recipe sits
          outside every worktree and nothing an agent can reach may write it. Edit{" "}
          <span className="mono">{underHome(view.at)}</span> and this page says so on the next
          render — the file is read on every resolve, so a daemon holds nothing stale.
        </p>
      </div>
    </main>
  );
}

export default async function RecipePage({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  const name = decodeURIComponent(project);
  // Registered only: a repository that is recorded and not yet conducted has no
  // recipe to resolve, and `notFound` is the honest answer for a name nothing
  // here has heard of.
  const state = (await loadProjects()).find((p) => p.project === name);
  if (state === undefined) notFound();
  return <Recipe view={await projectRecipe(state)} />;
}
