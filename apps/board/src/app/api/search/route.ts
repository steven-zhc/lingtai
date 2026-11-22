/**
 * The ⌘K index (#908): pages, projects, recipes, tickets and PRs, from the log and
 * the register — never from GitHub, because a key press that fans out to
 * GitHub costs a request per project per open.
 *
 * Every read is caught on its own and said in `problems`; a refused store is a
 * 200 whose index is the pages alone, so the palette on the not-set-up screen
 * still lists them. All the logic is `buildIndex`, which a test can reach.
 */
import { storeChoice } from '@lingtai/env'
import { loadProjects } from '@lingtai/project'
import { readTasks } from '@lingtai/projector/task-view'
import { Effect } from 'effect'

import { emptyIfUnbuilt, onBoardProjects } from '@/lib/board'
import { readSearchPrs } from '@/lib/prs'
import { type SearchPr, buildIndex } from '@/lib/search'

export const dynamic = 'force-dynamic'

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))

export async function GET(): Promise<Response> {
  const choice = storeChoice()
  if ('refused' in choice) {
    const refused = new Error(choice.refused)
    return Response.json(buildIndex({ tasks: refused, projects: refused }))
  }
  const [tasks, logged, registered] = await Promise.all([
    readTasks({}).catch((e: unknown) => {
      try {
        return emptyIfUnbuilt(e)
      } catch (err) {
        return asError(err)
      }
    }),
    onBoardProjects().catch(asError),
    loadProjects().catch(asError),
  ])
  // The register and the log's own names both: a card can outlive its project.
  let projects: string[] | Error
  if (logged instanceof Error) projects = logged
  else if (registered instanceof Error) projects = registered
  else projects = [...logged, ...registered.flatMap((p) => (p.project === null ? [] : [p.project]))]
  // A team project's PRs, each read caught on its own: one that fails is its sentence, never an empty group.
  const prs = new Map<string, readonly SearchPr[] | Error>()
  const problems: string[] = []
  if (!(registered instanceof Error)) {
    const names = registered.flatMap((p) => (p.project === null ? [] : [p.project]))
    const reads = await Promise.all(
      names.map((name) =>
        Effect.runPromise(readSearchPrs(name)).then(
          (r) => ({ name, r }),
          (e: unknown) => ({ name, r: asError(e) }),
        ),
      ),
    )
    for (const { name, r } of reads) {
      if (r === 'solo') continue
      if (r instanceof Error) prs.set(name, r)
      else {
        prs.set(name, r.prs)
        problems.push(...r.problems)
      }
    }
  }
  const index = buildIndex({ tasks, projects, prs })
  index.problems.push(...problems)
  return Response.json(index)
}
