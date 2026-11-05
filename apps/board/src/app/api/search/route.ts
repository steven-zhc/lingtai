/**
 * The ⌘K index (#908): pages, projects, recipes and tickets, from the log and
 * the register — never from GitHub, because a key press that fans out to
 * GitHub costs a request per project per open.
 *
 * Every read is caught on its own and said in `problems`; a refused store is a
 * 200 whose index is the pages alone, so the palette on the not-set-up screen
 * still lists them. All the logic is `buildIndex`, which a test can reach.
 */
import { loadProjects } from '@lingtai/conductor/projects'
import { hasGitHubAuth, storeChoice } from '@lingtai/env'
import { readTasks } from '@lingtai/projector/task-view'

import { emptyIfUnbuilt, onBoardProjects } from '@/lib/board'
import { buildIndex } from '@/lib/search'

export const dynamic = 'force-dynamic'

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))

export async function GET(): Promise<Response> {
  const app = hasGitHubAuth()
  const choice = storeChoice()
  if ('refused' in choice) {
    const refused = new Error(choice.refused)
    return Response.json(buildIndex({ tasks: refused, projects: refused, app }))
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
  return Response.json(buildIndex({ tasks, projects, app }))
}
