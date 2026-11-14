/**
 * The recipe page's *recently blocked* (#1162): the refused connections of every task of one project.
 *
 * Read on render with two whole-log reads and no projection, joined in memory by `projectBlockedOf`. A read that
 * fails is `failed`, which the page says; it is never an empty list.
 */
import { log } from '@lingtai/event-store'

import { projectBlockedOf, type SandboxView } from './sandbox-view'

export type ProjectBlocked =
  | { readonly kind: 'read'; readonly blocked: SandboxView['blocked'] }
  | { readonly kind: 'failed' }

export async function loadProjectBlocked(project: string, now: Date = new Date()): Promise<ProjectBlocked> {
  try {
    const [claims, refused] = await Promise.all([
      log.queries.rowsOfType('TicketClaimed'),
      log.queries.rowsOfType('SandboxConnectionsRefused'),
    ])
    return { kind: 'read', blocked: projectBlockedOf(claims, refused, project, now) }
  } catch {
    return { kind: 'failed' }
  }
}
