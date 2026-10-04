/**
 * **What `#269`'s third review actually answered**, byte for byte (`#279`).
 *
 * `run-008da76d-52d8-4d57-83fc-ef62be90937c`, 00:32:44, `success · 61 turns ·
 * $8.97 · exit 0`. It is four findings — a `major` at
 * `packages/recipe/src/recipe.ts:1413` about `whyThatPair` gaining no `claim`
 * branch, with a failure scenario, and three minors — and it **ends one closing
 * brace short of valid JSON**. The transcript's `stop_reason` is `end_turn`, so
 * nothing truncated it: the model believed it had finished and had not.
 *
 * **`parseFindings` now recovers it** (`#318`). No fence to strip, and no `{` in
 * it that `text.slice(i)` parses from strictly, because an inner one is followed
 * by the rest of the array and the outer one never closes — every strict
 * candidate still fails, exactly as it always did. What is new is the second
 * reading: `readTolerantJson` sees every value in the object complete and only
 * the outer `}` missing, and closes it. `parsed: true` and the four findings
 * come back, because every one of them kept its `claim` and `failureScenario`
 * and the result is a `failed` verdict — the two conditions a repaired reading
 * has to clear before it counts for anything.
 *
 * **What it is a fixture for is still the seam, not the parser.** Before #318,
 * `parsed` did not reach `proposed`, so `carriesACriterion` was handed
 * `findings: []` and said the only thing it could: *no finding with a failure
 * scenario*. The pass parked as though the reviewer had held an opinion not
 * worth a round, and the four findings it did hold survived only because
 * somebody copied them into the ticket by hand. That is the failure this
 * fixture now proves fixed, rather than documents.
 *
 * Kept verbatim, and as a module rather than a file on disk: a test that read it
 * with `readFileSync` would be integration under
 * [0060](../../../../doc/decisions-archive/0060-the-gate-runs-unit-tests.md) §1, and the
 * one thing this has to stay is cheap to run beside the parser it is about.
 *
 * **Do not tidy it.** Closing the brace by hand defeats the point: the fixture
 * is only worth keeping while the text itself still ends one brace short, so the
 * recovery is the reader's and not a rewrite of the bytes.
 */
export const REVIEW_THAT_DID_NOT_PARSE =
  "{\"findings\":[{\"file\":\"packages/recipe/src/recipe.ts\",\"line\":1413,\"severity\":\"major\",\"claim\":\"`whyThatPair` gained no `step === \\\"claim\\\"` branch, so now that `queuePlugin` serves `claim` every other kind written there is refused with a sentence about `prepared` — the exact failure that function's own docblock says is \\\"worse than no reason\\\" and that `#268` added the `admit` branch to stop.\",\"failureScenario\":\"Before this diff `pluginsAt(\\\"claim\\\")` was empty, so `whyNoKindAt(\\\"claim\\\", k)` took the *no plugin implements* branch and printed `WHERE_INSTEAD.claim`. With `at: { claim: notBuiltYet }` that branch is gone and `whyThatPair(\\\"claim\\\", k)` falls through to the `prepared` sentences. Verified by calling `whyNoKindAt` on this tree: `claim`×`run` → \\\"`run:` does not implement `claim` — it serves `prepared`, `build`, `proposed`, `merge`: a hold at `prepared` cannot be answered — the run is released back to the queue and the question goes with it, so the item would re-claim, re-install and ask again on every pass\\\" (a sentence about a *hold*, for a `run:`, naming a step the operator never wrote); `claim`×`agent` → \\\"nothing has been committed at `prepared`, so a cold reviewer would be given no diff to read\\\"; `claim`×`watch` → \\\"nothing has been committed at `prepared`, so the globs would be matched against no file list\\\". An operator who writes `claim: [{name: \\\"warm the cache\\\", run: \\\"pnpm i\\\", timeout: \\\"5m\\\"}]` is told to move it to `prepared` by a reason that is false where it is printed, and `step-matrix.test.ts` pins the sentence at `admit`, `build` and `review` but asserts nothing about `claim`'s. The diff's own `doc/reference.md` asserts the opposite — that the eleven other kinds at `claim` are \\\"refused in `admit`'s own terms instead, with the same remedy: … `lingtai ask`\\\" — which no code path produces.\"},{\"file\":\"doc/reference.md\",\"line\":1304,\"severity\":\"minor\",\"claim\":\"The bullet the diff rewrote still says \\\"*nothing implements `claim`* is true\\\" and sends the reader to `CALLED_DIRECTLY` for the code that picks their ticket — both false as of this diff, which gave `claim` a plugin and deleted `CALLED_DIRECTLY.queue`.\",\"failureScenario\":\"A reader of the *A plugin that serves no step at all* bullet reads, two lines after being told `queue:` left that list in `#269`, that \\\"*nothing implements `claim`* is true and leaves a reader hunting for the code that picks their ticket. `CALLED_DIRECTLY` names it instead.\\\" They open `recipe.ts` looking for `CALLED_DIRECTLY.queue`, which this diff removed, and for a step with no plugin, which `claim` no longer is. The sibling sentence inside `recipe.ts`'s own docblock was corrected to `no plugin implements \\\\`end\\\\``; this copy was not.\"},{\"file\":\"apps/board/src/lib/recipe.ts\",\"line\":695,\"severity\":\"minor\",\"claim\":\"`readRecipe`'s rows still attribute their values to the v1 keys (`source.kinds`, `source.exclude`, `source.backoff`, `runtime.assignee.*`) although the four accessors they read now prefer a `queue:` declared at `claim`, so the source column names a setting that no longer decides.\",\"failureScenario\":\"An operator follows the ticket's instruction and pastes `claim: [{name: \\\"take the ticket\\\", queue: {kinds: [bug, tech-debt], exclude: [agent:hold], backoff: 45m, assignee: {take: both}}}]` into `~/.lingtai/lingtai/recipe.yml`, leaving `source.kinds: [bug, tech-debt, feature, documentation]` above it. The board's recipe reading shows `picks up: bug > tech-debt` (from the block, via `kindsOf`) but `sourceOf` looks up `provenance[\\\"source.kinds\\\"]`, so the row is attributed to a key whose own value is the four-kind list. The operator edits `source.kinds` to re-add `feature`, restarts the daemon, and the queue goes on taking two kinds; `provenanceRows` displays the edited `source.kinds` value beside it as though it were live. `baseOf`/`submodulesOf` avoided this by having no reading row at all.\"},{\"file\":\"apps/board/src/lib/recipe.ts\",\"line\":534,\"severity\":\"minor\",\"claim\":\"`describeAction`'s `queue` case still explains itself as a reading for a key no step can hold — \\\"the queue calls it itself today, so no step can hold one\\\" — which this diff made false.\",\"failureScenario\":\"A reader of the task page's action rows, or anyone editing this switch, reads that a `queue:` cannot appear at any step and concludes the branch below it is dead code kept for a future ticket. It is now the branch that renders every `claim` row for a recipe that declares its queue at the step — the case immediately above it (`merge:`) carries no such claim because `#270` removed it when the lane became declarable.\"}]";
