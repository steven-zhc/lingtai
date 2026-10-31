/**
 * **The subject of a landing merge**, and nothing else (#776).
 *
 * `integrate.ts` writes it and the release notes parse it
 * (`apps/release/src/tickets-changed.ts`), so both sides compose one string.
 * This module imports nothing: `@lingtai/repo`'s `.` export reaches `pg` and
 * the event store, which a release unit test has no business loading.
 */
export function landingSubject(branch: string): string {
  return `Merge branch '${branch}' into HEAD`
}
