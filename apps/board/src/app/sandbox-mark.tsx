/**
 * One project's sandbox state, small, beside the name it belongs to in the filter menu (#1166). A span and never a link: it sits inside one. Absent state draws nothing — a failed read is no mark, never *sandboxed*.
 */
import type { SandboxState } from '@/lib/sandbox-state.ts'

import { SandboxShield } from './sandbox-shield.tsx'

export function ProjectSandboxMark({ state }: { state: SandboxState | undefined }) {
  if (state === undefined) return null
  return (
    <span className={`sbx sbx-${state.state} sbx-row`} role="img" aria-label={state.sentence} title={state.sentence}>
      <SandboxShield state={state.state} />
    </span>
  )
}
