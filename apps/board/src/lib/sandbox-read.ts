/**
 * The sandbox icon's read (#1163): the registered projects the page already has (`readRegistered`, one read per
 * render however many ask), folded to states. **Nothing else is read** — no attempt stream, no `rcp-`, and never the
 * host: `hostHere` imports srt, and a probe on every page is the cost #112 fought.
 */
import { readRegistered } from './locks.ts'
import { sandboxFactsOf, sandboxState, worstOf, type SandboxMark, type SandboxState } from './sandbox-state.ts'

/**
 * The selected project's mark, or the worst across projects when none is selected. Rejects when the read fails:
 * the slot says so and never draws *sandboxed*.
 */
export async function readSandboxMark(project: string | undefined): Promise<SandboxMark | undefined> {
  const projects = await readRegistered()
  const states = new Map<string, SandboxState>()
  for (const p of projects) {
    if (p.project === null || (project !== undefined && p.project !== project)) continue
    states.set(p.project, sandboxState(sandboxFactsOf(p)))
  }
  return worstOf(states)
}
