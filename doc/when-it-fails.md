# When something fails

*What Lingtai does on its own, what it asks you, and where you see it*

Things go wrong while a ticket is being built: an API is down, a test is flaky, the review finds a bug. Lingtai answers each one in one of three ways, and every answer has a limit, so nothing loops forever and nothing spends money without end. This page is for somebody who has run the [tutorial](tutorial.md) and wants to know what happens when it does not go smoothly.

## The three tiers

**A rule** handles most failures. It is fixed in advance, costs nothing, and no AI decides it: wait and try again, merge the new main, run the checks once more.

**One quick AI look** handles some, once your recipe declares one (see below). When a rule cannot tell what to do, such as which lines a review wants changed or how to cut up a ticket that ran out of time, one short AI call reads what happened and answers. It costs cents.

**You** are asked only for a decision: what an unclear ticket meant, how to go on once a limit that bounds the retries has run out. Lingtai never answers that for you.

Past its limit, a tier hands up to the next one, and the last one is you.

## The common failures

The numbers below come from the code, and each row names its line. Some are settings in your recipe (marked **recipe**); the rest are fixed in code on purpose, because a value somebody can set is a value somebody can set to a loop (`respond.ts:574-578`).

| What went wrong | What happens | Who | The limit, and past it |
|---|---|---|---|
| The API is down | The half-done work is saved, it waits, and redoes the step | Rule | 3 tries, after 1, 5, then 15 minutes (`respond.ts:581-583`). Then it asks you; the saved work is still there |
| A flaky test | The checks run again once on the same code | Rule | One rerun (`process-action.ts:224`). Red twice means it is real, and the agent fixes it |
| AI review found a bug, or the checks stay red | The agent fixes the lines on top of its own work: a red check goes straight to a fix round by rule, and a review finding is named by one look | Rule for red checks; for review findings, one look if your recipe declares a `judge:` for them, otherwise you | 6 fixes (**recipe**, `recipe.ts:3361`). Then a fresh start from main, at most 2 (**recipe**, `recipe.ts:3381`), or it asks you |
| The ticket is unclear | It stops before guessing and asks you; your answer goes into the ticket | You | 5 stops per ticket (`wait.ts:605`). After that it waits for you to decide |
| The ticket is too big | One look splits it into parts that run in order; when all have landed the ticket runs again against its own Done-when, and can need more work or you | One look, if your recipe declares `triage:`; otherwise you | Split once per ticket (`respond.ts:593`), into at most 8 parts (`triage.ts:48`). A part that is still too big comes to you |
| Someone else changed main | The new main is merged into the work, the checks run again, then it lands | Rule | 10 merges per attempt (`respond.ts:587`). Then it asks you |
| Merging main conflicts | While fix rounds remain, a fix round resolves the conflict, with no AI deciding first; a conflict it cannot resolve starts fresh or comes to you | Rule | 6 resolutions (**recipe**, `recipe.ts:3368`; routing at `respond.ts:1005-1009`) |
| Origin refused the landing | When origin could not be reached or answered with an error, the landing is tried again; any other refusal, such as a protected-branch rule, is not retried and asks you at once | Rule | 3 times, on the same waits as the API (`respond.ts:585`, `respond.ts:810-820`). Then it asks you |
| The quick look itself failed | It is asked once more | Rule | One more ask (`respond.ts:591`). Then it asks you |
| The Claude limit ran out | The ticket is held until the limit lifts, then taken again. A limit met before a step started spent nothing; one that cuts a step off mid-run may already have spent on it | Rule | Nothing to count, and waiting is free; it is checked before any redo (`respond.ts:596-600`). A limit that names no reset, like a monthly cap, is retried after the recipe's backoff (`respond.ts:395`, `account.ts:96`), and a limit that interrupts a running step is handled the same way (`conduct.ts:6395-6413`) |
| The base is already red | Lingtai opens one fix ticket for the first red commit, rather than one per ticket that trips on it | Rule | One per first red commit (`integration.ts:183-205`); not counted against any ticket |
| The setup is broken | No guessing: it asks you straight away | You | No limit and no tries (`respond.ts:1011-1012`) |

**The one-look rows need setup.** Splitting a big ticket needs a `triage:` in your recipe, and an AI judgement on review findings needs a `judge:` at `proposed:`; neither has a default. Without them the ticket waits for you at that point instead. The rule rows need nothing.

A failure not listed here is answered the same way, and the full list of reasons and answers is in the [reference](reference.md). What the reference does on an attempt that fails is in [operating](operating.md).

## Where you see it

- **Handled for you** is what was fixed without you: on the home page and on `/report`, one line for what went wrong and what Lingtai did about it (`apps/board/src/lib/handled.ts`, `apps/board/src/app/report/panels.tsx:515`).
- **Waiting on you** is what needs you, with the moves you can take on each ticket (`apps/board/src/lib/board.ts:534`).
- **why nothing runs** sits under the queue when work is queued and nothing is taking it: a pause, the day's ceiling, a limit (`apps/board/src/app/queued-stream.tsx:336`).

## What you can change in the recipe

- **Approval before landing:** a `human:` at `proposed:` holds every attempt for you one step before it lands (see [recipe](recipe.md)).
- **A judge for a refusal:** a `judge:` at `proposed:` decides what happens after a refusal, in place of asking you (see [recipe](recipe.md)).
- **The limits you can set:** `runtime.limits.attempt.refusalFixes`, `runtime.limits.attempt.conflictResolutions` and `runtime.limits.ticket.newAttempts`, and the turns and time one call may spend (see [reference](reference.md)). The other numbers on this page are not settings.
