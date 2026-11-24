# When something fails

*What Lingtai fixes on its own, what it asks you, and where you see it*

Things go wrong while a ticket is being built: an API is down, a test is flaky, the review finds a bug. Lingtai answers each one in one of three tiers, and every answer has a limit, so nothing loops forever and nothing spends money without end. This page is for somebody who has run the [tutorial](tutorial.md).

## The three tiers

**A rule** answers first. It is fixed in advance and costs nothing: wait and try again, merge the new main, run the checks once more.

**An AI judge** answers when a rule cannot tell, once your recipe declares one. It reads what happened and names a cause; it never names an action. Lingtai picks the action.

**A person** is last, and is asked only where a limit is spent, a ticket is unclear, or the environment is broken. Lingtai never answers those for you.

Past its limit, a tier hands up to the next one.

## The common failures

Limits marked **recipe** are settings; the rest are fixed in code.

| What went wrong | What happens | Who | The limit, and past it |
|---|---|---|---|
| The API is down | Work is saved, it waits, and redoes the step | Rule | 3 tries, after 1, 5, then 15 minutes. Then it asks you |
| A flaky test | The checks run again once on the same code | Rule | One rerun. Red twice means it is real, and the agent fixes it |
| AI review found a bug, or the checks stay red | The agent fixes the lines on top of its own work | Rule for red checks; AI judge for review findings if your recipe declares a `judge:`, otherwise you | 6 fixes (**recipe**). Then a fresh start from main, at most 2 (**recipe**), or it asks you |
| The ticket is unclear | It stops before guessing and asks you; your answer goes into the ticket | You | 5 stops per ticket. After that it waits for you |
| The ticket is too big | It is split into parts that run in order | AI judge, if your recipe declares `triage:`; otherwise you | Split once, into at most 8 parts. A part still too big comes to you |
| Someone else changed main | The new main is merged in, the checks run again, then it lands | Rule | 10 merges per attempt. Then it asks you |
| Merging main conflicts | A fix round resolves the conflict | Rule | 6 resolutions (**recipe**) |
| Origin refused the landing | Transient errors are retried; any other refusal goes to a judge if one is declared, otherwise to you | Rule | 3 times. Then it asks you |
| The Claude limit ran out | Held until the limit lifts, then taken again | Rule | Nothing counted, and waiting is free |
| The base is already red | One fix ticket is opened for the first red commit | Rule | One per first red commit |
| The setup is broken | No guessing: it asks you straight away | You | No limit and no tries |

**The AI judge rows need setup.** Splitting a big ticket needs `triage:` in your recipe, and a judgement on review findings needs `judge:` at `proposed:`. Neither has a default; without them the ticket waits for you at that point. Rule rows need nothing.

A failure not listed here is answered the same way; the full list is in the [reference](reference.md).

## Where you see it

**Handled for you** on the home page and `/report` counts what was fixed without you. **Waiting on you** lists what needs you, with the moves you can take. **Why nothing runs** sits under the queue when work is queued and nothing takes it: a pause, the day's ceiling, a limit.

To find out why one ticket failed, read from the narrowest view outward:

1. The attempt's row on `/task/<id>`. Read the outcome word first; `never-started` is Lingtai's own failure, not the ticket's.
2. The evidence of the refusing check, through the pointer on that row.
3. The run log, with [`lingtai attach <runId>`](cli.md#lingtai-attach). A run that landed has no log.
4. Triage's summary, which is the cause it named. What was done with it is Lingtai's choice.

## Next

[The recipe](recipe.md): the judge, triage, approval and limits are set there.
