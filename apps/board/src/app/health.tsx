/**
 * The bar's one health indicator, and the server half of it.
 *
 * This used to be two chips. `live.tsx` answered *is what I am looking at
 * current?* (`#64`) and `stale.tsx` answered *is the process that moves it
 * running the code we merged?* (`#98`) — two independent facts, so two chips,
 * which is the argument each of them made on its own and neither made about
 * the row. Eleven objects later the row was the thing that was wrong
 * ([the-bar.md](../../../../doc/design/the-bar.md)), and two boxes for one
 * question is two things to learn to read on a rail that is glanced at.
 *
 * They are one dot now. Neither fact is reduced *away*: `bearing.ts` keeps both
 * in the title in every state, and whichever one is wrong is the sentence
 * beside the dot. What is gone is the second box.
 *
 * **Split here rather than merged into the health frame.** This shells out to
 * git, and git has no business on the SSE tick that every open tab drives every
 * 25 seconds — which is what `stale.tsx` was a server component for. So the
 * currency is read here, once per render, and handed to the client component as
 * a prop; the lag and the beacon still arrive on the stream, where they change
 * every few seconds and this does not.
 *
 * `Stale` is gone and 0010 still reads as though it removed the restart:
 * *the source runs unbuilt* removes the build step, and Node caches a module at
 * import, so a daemon is a deployment of whatever `HEAD` pointed at when it
 * started. This only ever reports. Whether a daemon should restart itself is
 * deliberately open.
 */
import { isSea } from 'node:sea'

import { lastBeat, readStatus } from '@lingtai/daemon/control'
import { codeCurrency, describeCurrency } from '@lingtai/daemon/currency'
import { installFor } from '@lingtai/recipe'

import type { CodeNews, SandboxNews } from '@/lib/bearing'
import { readSandboxFacts } from '@/lib/sandbox-read'
import { stoppedProjects } from '@/lib/sandbox-state'

import { Live } from './live.tsx'

/**
 * What the beacon and the checkout say between them, or null when there is
 * nothing to say.
 *
 * Null on no daemon and on a daemon that stopped beating: nothing is then
 * holding old modules open, and the lag half of the dot already says the board
 * is not being advanced. Saying it twice would be the second chip again.
 */
async function news(): Promise<CodeNews | null> {
  const status = await readStatus().catch(() => null)
  if (!status) return null
  if (!lastBeat(status).up) return null

  if (!status.codeSha) {
    // An installed binary has a release version, not a checkout commit. Its
    // missing SHA is expected and cannot be repaired by restarting the daemon.
    if (isSea()) {
      return {
        wrong: null,
        command: null,
        said: 'running an installed Lingtai binary; Git commit comparison does not apply',
      }
    }
    return {
      wrong: 'code unknown',
      command: 'lingtai restart',
      said: 'this daemon started before the beacon carried a commit, so what code it is running cannot be read from here',
    }
  }

  const currency = await codeCurrency({ sha: status.codeSha, dirty: status.codeDirty }).catch(() => null)
  // Not knowing is the same silence this exists to break, so it says so rather
  // than reading as though the daemon were current.
  if (!currency) {
    return {
      wrong: 'code unknown',
      command: 'lingtai doctor',
      said: "the daemon's commit could not be compared against the repository",
    }
  }
  // `unknown` is a comparison that could not be made — a sha the checkout no
  // longer holds, a base ref never fetched. `describeCurrency` says which, and
  // it is not a fault to act on.
  if (currency.unknown || currency.behind.length === 0) {
    return { wrong: null, command: null, said: describeCurrency(currency) }
  }
  return {
    wrong: `daemon ${currency.behind.length} commits behind`,
    command: 'lingtai restart',
    said: describeCurrency(currency),
  }
}

/**
 * The projects in scope whose required sandbox is not running, or null when none is. **A failed read is not none**:
 * health reads its own facts and never sees this rejection, so it says the uncertainty itself (#1167).
 */
export async function sandboxNews(project: string | undefined): Promise<SandboxNews | null> {
  const facts = await readSandboxFacts().catch(() => null)
  if (facts === null) {
    return {
      wrong: 'sandbox state unreadable',
      command: 'lingtai doctor',
      said: 'could not read which projects require a sandbox',
    }
  }
  const stopped = stoppedProjects(facts, project)
  if (stopped.length === 0) return null
  const install = installFor(process.platform)?.command
  const names = stopped.length === 1 ? stopped[0]! : `${stopped.length} projects`
  return {
    wrong: `${names} stopped: no sandbox`,
    command: install ?? 'lingtai doctor',
    said: `${stopped.join(', ')} require${stopped.length === 1 ? 's' : ''} a sandbox this host cannot provide`,
  }
}

/**
 * Not `async`, and `code` is a promise: `Live` stays mounted across a project
 * switch and reads it under its own boundary. An async component here would
 * block the shell on git.
 */
export function Health({
  near,
  runnable,
  projectKey,
  project,
}: {
  project?: string | undefined
  near: Promise<string | null>
  runnable: Promise<number | null>
  projectKey: string
}) {
  return <Live code={news()} sandbox={sandboxNews(project)} near={near} runnable={runnable} projectKey={projectKey} />
}
