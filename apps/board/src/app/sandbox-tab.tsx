import Link from 'next/link'

import { sandboxTabPath } from '@/lib/tabs'
import type { SandboxTabDetail } from '@/lib/task'

import { SandboxPanel } from './sandbox-panel.tsx'

/** The Sandbox tab (#1161): the attempt switcher, then the recorded boundary of the selected attempt. */
export function SandboxTab({ detail }: { detail: SandboxTabDetail }) {
  const { taskId, attempts, selected, view } = detail
  return (
    <div className="sandboxtab">
      {attempts.length === 0 ? null : (
        <nav className="sbswitch" aria-label="Attempt">
          {[...attempts].reverse().map((n) => (
            <Link
              key={n}
              href={sandboxTabPath(taskId, n)}
              scroll={false}
              aria-current={n === selected ? 'page' : undefined}
            >
              Attempt {n}
            </Link>
          ))}
        </nav>
      )}
      {view === null ? (
        <p className="empty">No attempt has run yet, so nothing was recorded.</p>
      ) : (
        <SandboxPanel view={view} />
      )}
    </div>
  )
}
