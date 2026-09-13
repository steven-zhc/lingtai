/**
 * Who is acting.
 *
 * The local account, because the board runs on one machine for one person
 * (0007). A weak claim, but a true one, and an approval that recorded nobody
 * would be the silent waiver this system exists to remove.
 *
 * Separate from `actions.ts` because a `"use server"` module may only export
 * async functions, and because `apps/cli/test/waive.test.ts` asserts that a
 * waiver from the terminal records the same actor as a click — against this
 * function, not a copy of it.
 */
import { userInfo } from "node:os";

export function actor(): string {
  return `human:${userInfo().username}`;
}
