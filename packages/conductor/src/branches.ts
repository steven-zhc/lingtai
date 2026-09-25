/**
 * **The names of the refs a pass owns**, and nothing else — `agent/<n>`, its
 * arms, and the prefix a sweep matches on.
 *
 * They were `restart.ts`'s until `#240` gave them a second reader. The sweep at
 * `end` deletes what the publish wrote, so both sides have to be composing one
 * string; and `tell.ts` is where the deleting happens, which is why the names
 * cannot live behind `restart.ts` any more. **`restart.ts` imports `fix.ts` for
 * a type, `fix.ts` imports `@lingtai/actions` for one, and a type import is
 * still a file in the program**: importing a branch name from there put
 * `packages/actions/src/command.ts` — the process-spawning code — into
 * `apps/board`'s Next program, which is a program it does not typecheck under,
 * and `pnpm typecheck` went red four errors deep in a file the change never
 * touched.
 *
 * So this module imports nothing, and a name is reachable from anywhere without
 * dragging a decision or a `spawn` along with it. The four errors in
 * `command.ts` are a separate fault and are still there, waiting for the next
 * edge that reaches it.
 */

/**
 * Where a claim's commits are published, so a later claim cannot overwrite them.
 *
 * **A ref per arm, because `agent/<n>` is one ref and there are as many arms as
 * the item has claims.** The push is what makes the next prompt's `git fetch
 * origin agent/<n>` true (0040 §2) — but the claim after it pushes the same
 * name, force, from a history with no ancestor in common. So `agent/<n>` is the
 * *newest* arm and this is every arm: `PassRestarted` names one of these, and
 * the claim that an arm on the log is an arm that can be read is then true of
 * all of them and not only the last.
 *
 * **`n` is the claim's attempt ordinal (`attempts.ts`), not its restart
 * ordinal** ([0062](../../../doc/decisions/0062-what-a-claim-leaves-behind.md)
 * §2). The name was `-restart-<k>`, and the problem was never collision — it is
 * that the number does not always exist. A claim that ran out of turns never
 * restarted, so there is no restart ordinal to name its commits by, and #237's
 * 36 edits had nowhere to go. Every restart releases the claim and claims
 * again, so every restart is also an attempt and the reverse does not hold: one
 * axis, defined for every ending, subsuming the one it replaces. Keeping both
 * would give one set of commits two names.
 *
 * A sibling of `agent/<n>` rather than a child of it, because git cannot hold
 * `refs/heads/agent/7` and `refs/heads/agent/7/attempt-1` at once — a ref
 * cannot also be a directory. The name says which attempt rather than which
 * sha, so a pass that pushed and then failed to record its arm re-pushes the
 * same name on the retry instead of stranding one.
 */
export function armBranch(branch: string, n: number): string {
  return `${armPrefix(branch)}${n}`;
}

/**
 * **The branch a ticket's passes own**, `agent/<n>`, from the issue number.
 *
 * One function because the name is now read by something that *deletes* it
 * (`#240`): `refs:` at `end` sweeps what this and `armBranch` wrote, and a
 * cleanup working from its own spelling of the name is a cleanup that misses
 * the refs, or hits somebody else's. `run-once.ts` and `approve.ts` compose it
 * too, so the publish and the delete are provably about one string.
 */
export function agentBranch(issue: number | string): string {
  return `agent/${issue}`;
}

/**
 * **What every arm of a branch begins with**, and so what a sweep matches on.
 *
 * `agent/<n>` is not a prefix of its own arms in the way that matters —
 * `agent/24` is a prefix of `agent/240`'s refs as a string — so the deleting
 * side asks for this and never for the branch, and takes the branch itself by
 * equality.
 */
export function armPrefix(branch: string): string {
  return `${branch}-attempt-`;
}
