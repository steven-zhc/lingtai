/**
 * The integration files that assert Postgres itself, and the one place that
 * says so — #275's answer to "which files still need a second database".
 *
 * A list kept in prose drifts (0055 §1: "a set maintained by memory rather
 * than by a type"). This one does not stand alone: `packages/event-store/unit/
 * on-postgres.test.ts` reads every integration file's own code — comments
 * stripped, so a sentence *about* Postgres is never mistaken for reaching it —
 * and fails if one calls `pg`, `createDb(` or `createPostgres…(` without being
 * listed here, or if a listed file no longer does. Resolving a connection
 * *string* does not count: `packages/daemon/integration/the-written-choice.test.ts`
 * calls `directPostgresUrl()` freely and needs nothing here, because its
 * "postgres" cases hand the string to a stubbed socket that never opens one.
 *
 * Each reason names what only Postgres has — 0016 §4's shape is a file that
 * stays green while asserting nothing, so a file on this list wraps its own
 * tests in `describe.skipIf(!postgresUnderTest())` rather than converting to
 * SQLite: the skip is visible in vitest's own count, where a silent pass would
 * not be.
 */
import { dbVar } from '@lingtai/env'

export const ON_POSTGRES: Record<string, string> = {
  'packages/event-store/integration/event-store.test.ts': 'two clients racing an append',
  'packages/conductor/integration/claim.test.ts': 'two clients racing a claim',
  'packages/event-store/integration/subscribe.test.ts': 'createPostgresWaker — LISTEN/NOTIFY',
  'packages/event-store/integration/queries.test.ts': 'the Postgres side of the queries contract',
  'packages/projector/integration/projection.test.ts': 'the Postgres projection store and projectionShape',
  'packages/daemon/integration/daemon-store.test.ts': 'createPostgresDaemonStore',
  'packages/daemon/integration/beacon.test.ts': 'the Postgres beacon',
  'packages/projector/integration/task-view.test.ts':
    'seed() inserts a retired event type with a raw, Postgres-syntax `::jsonb` statement, and every case reads what it wrote',
  'apps/cli/integration/doctor.test.ts':
    "only its 'against the real database' describe — session mode, the pooler rows, and Phase 0's green check",
  'packages/conductor/integration/queue.test.ts':
    'only one case — readAttempt()/drop() read and clean task_view with a raw, Postgres-only pg.Client',
  'packages/conductor/integration/db-tickets.test.ts':
    'the Postgres DDL for tickets and ticket_comments — timestamptz and BIGSERIAL',
}

/**
 * Whether this process can reach the Postgres the files above need — read
 * without throwing, unlike `postgresUrl()`, which is for a caller about to
 * connect and refuses by name where nothing is set.
 *
 * `dbVar` picks the test-side name the same way `storeChoice` and `postgresUrl`
 * do, so this agrees with them about which variable answers in a test.
 */
export function postgresUnderTest(from: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(from[dbVar('DATABASE_URL', from)])
}
