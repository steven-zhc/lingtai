/**
 * One project's sandbox state, small, beside the name it belongs to (#1166). A span and never a link: in the filter
 * and on a landed row it sits inside one. Absent state draws nothing — a failed read is no mark, never *sandboxed*.
 */
import { GLYPH, type SandboxState } from '@/lib/sandbox-state.ts'

export function ProjectSandboxMark({ state }: { state: SandboxState | undefined }) {
  if (state === undefined) return null
  return (
    <span className={`sbx sbx-${state.state} sbx-row`} role="img" aria-label={state.sentence} title={state.sentence}>
      <span className="sbx-mark" aria-hidden="true">
        {GLYPH[state.state]}
      </span>
    </span>
  )
}
