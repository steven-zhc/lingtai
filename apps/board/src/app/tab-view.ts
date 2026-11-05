import { defaultTabOf } from '@/lib/tabs'
import { loadAttemptTab, loadTicketTab, readAttempts, type AttemptTabDetail, type TicketTabDetail } from '@/lib/task'

/**
 * How a child page's read ended. A failed read is a sentence in the tab and
 * never an error page, and the top of the page — the layout's — is unaffected
 * (#885). The sentence names the read and not the error: an error's message may
 * carry a URL or a token (`timing.ts`).
 */
export type TabRead<T> = { status: 'ok'; detail: T } | { status: 'missing' } | { status: 'failed' }

export async function guarded<T>(load: () => Promise<T | null>): Promise<TabRead<T>> {
  try {
    const detail = await load()
    return detail === null ? { status: 'missing' } : { status: 'ok', detail }
  } catch {
    return { status: 'failed' }
  }
}

export type DefaultTab = { kind: 'attempt'; detail: AttemptTabDetail } | { kind: 'ticket'; detail: TicketTabDetail }

/** What `/task/<id>` shows in place: the default tab's content, not a redirect. */
export function loadDefaultTab(taskId: string): Promise<TabRead<DefaultTab>> {
  return guarded<DefaultTab>(async () => {
    const { standing, runs } = await readAttempts(taskId)
    const key = defaultTabOf(standing, runs)
    if (key === 'ticket') {
      const detail = await loadTicketTab(taskId)
      return detail === null ? null : { kind: 'ticket', detail }
    }
    const detail = await loadAttemptTab(taskId, key.attempt)
    return detail === null ? null : { kind: 'attempt', detail }
  })
}
