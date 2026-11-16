# Acceptance — #594: a review after a base-moved merge is shown what landed on the base for the overlapping paths

No page is touched by this ticket, so there is no style table and no visual checklist.

## The interface these tests fix

The ticket leaves three names to the implementer. The tests need to call them, so they fix these three:

| Where | Name | Shape |
|---|---|---|
| `packages/actions/src/action.ts` `ActionContext` | `baseMoved?` | `{ paths: string[]; fromSha: string; toSha: string }`. This is the `base-moved` refusal's own `ActionResult.baseMoved` (#593). It is absent on every review except one that runs after a `MergeBase` route. |
| `packages/actions/src/agent-action.ts` `AgentActionDeps` | `baseDiff` | `(fromSha, toSha, paths) => Promise<string>`. The caller supplies it the same way it supplies `diff`, because the actions package runs no git. It is called only when `context.baseMoved` is set. |
| `packages/conductor/src/conduct.ts` | `export baseDiffArgs` | `(fromSha, toSha, paths) => string[]`. This is the git argv that `stepDeps.agent.baseDiff` runs in the pass's worktree (`git diff fromSha toSha -- <paths>`). It follows the same pattern as `changedFilesArgs`. |

## Tests

| File | Half |
|---|---|
| `packages/actions/unit/acceptance-594.test.ts` | The prompt: section, question, cap, and the byte-for-byte check on ordinary reviews |
| `packages/conductor/unit/acceptance-594.test.ts` | The route: which review gets `baseMoved` |
| `packages/conductor/integration/acceptance-594.test.ts` | Git: the argv against a real repository |

## Map

| Ticket line | Proved by |
|---|---|
| **Want**: *when the review runs after a `base-moved` merge* | conductor unit: *the review after a base-moved merge is handed the refusal's paths and shas; the first review is handed none*, and *a second base-moved merge hands the next review the second refusal's own paths and shas* |
| **Want**: *its prompt carries the base's new changes to the overlapping paths* | actions unit: *the prompt carries the base diff of exactly the overlapping paths between the two shas*; conductor integration: *is the base's own change between the two shas, to exactly the overlapping paths* |
| **Want**: *and asks specifically whether that new logic changes what the branch's change does or assumes* | actions unit: *the section asks whether what landed on the base changes what this change relies on or alters, naming a line on each side* |
| **Fix**: carry `{ paths, fromSha, toSha }` into the continued pass's context | conductor unit (both tests) |
| **Fix**: `git diff fromSha toSha -- <paths>` | conductor integration. This test runs against real git: one path the base alone changed, one file only the branch changed, the branch's own edits to overlapping files, and a path containing a space. |
| **Fix**: *findings go through the ordinary `findings` route* | actions unit: *findings from a base-moved review go through the ordinary findings route* |
| **Watch out**: cap at about 400 lines, say it was cut, name the paths left out | actions unit: *a base diff over the cap (~400 lines) is cut, says so, and names the paths left out*, and *a base diff under the cap is shown whole and says nothing about a cut* |
| **Watch out**: *an ordinary review's prompt is unchanged byte for byte* | actions unit: *an ordinary review is unchanged byte for byte, and the base-moved one only adds to it*. It also checks that the contract is still the last thing in the prompt (#368). |
| **Done when 1**: the section has the diff of exactly the overlapping paths between the two shas, and an ordinary review's prompt is unchanged | actions unit, tests 1 and 3; conductor integration |
| **Done when 2**: a diff over the cap is cut and says which paths were left out | actions unit, the over-cap test |
| **Done when 3**: `pnpm typecheck` and `pnpm test` are green | No test can check this. A person runs both. These acceptance files are part of `pnpm test`'s unit project, so they must pass there too. |

## What these tests do not check

- **The line in `conduct.ts` that wires `baseDiff` into `stepDeps.agent`.** It sits inside `conduct`'s closure, and no unit test reaches it. The integration test proves the argv. The actions test proves what the action does with the dep. If `baseDiff` is a **required** field of `AgentActionDeps`, `pnpm typecheck` will refuse a `conduct.ts` that does not supply it. That makes the wiring a compile-time fact, and I recommend it. The cost is updating the hand-built deps in the existing tests.
- **Whether the reviewer actually reads the section and names a line on each side.** That is a model's behaviour and no test here can assert it. The tests prove only that the question is asked.
- **Where the section sits in the prompt.** The tests require that every line of the ordinary prompt survives in order and that the contract stays last. They do not fix the section's position or its heading.
- **What happens to `b.ts`, the path the cap cuts partway through.** The over-cap test requires that its far end is absent and that `c.ts`, which is wholly absent, is named. Whether a partly shown path is also listed is left to the implementer.
