# Additional findings on build b9f27c1

The legacy-numbering gap affects search and task attribution as well as the
PR list. A separate, measured performance cost is that a freshly mounted
live-update subscription replays the event log from zero. Empty PR lists
also retain an unnecessary full-project spend read. These findings do not
change the earlier retest's blocked acceptance result.

## Confirmed live-update replay overhead

`apps/board/src/app/live.tsx:129` initializes `lastSeq` to `'0'`. A new
subscription connects with that cursor (`:189`), and every received append
calls `schedule()` (`:195–:207`), including historical events. This ref
survives re-renders of the same component, but a new mount starts from zero.
The server passes that cursor to `subscribe` at
`apps/board/src/app/api/stream/route.ts:124–:125`. The subscription drains all
events after it, a batch at a time
(`packages/event-store/src/subscribe.ts:200–:207`).

At **2026-11-25 23:17 UTC / 17:17 CST**, the current event head was **66,281**.
Two serial, read-only SSE probes were each capped at two seconds and 512 KiB:

| Cursor | Elapsed before intentional stop | Bytes received | Append frame headers | Event range |
|---|---:|---:|---:|---|
| Current head, 66,281 | 2.005 s | 131 | 0 | No historical replay |
| Fresh mount, 0 | 1.136 s | 524,288 | 4,514 | 1–4,514; stopped at byte cap |

Curl exits 28 and 63 are the deliberate time/size limits, not server failures.
The byte cap cuts the last frame: 4,513 messages were fully parsed and the
4,514th header/id was received before its payload was truncated.
The full 66,281-event replay was not measured. The evidence establishes
avoidable catch-up traffic; source shows the historical append handlers mark
the page stale. This probe did not count completed React refreshes, so it
does not establish one render per historical event.

This is a more useful next measurement than simply increasing the count of
HTTP roots: automatically repeated renders are not independent human
navigations. A safe initial subscription needs a cursor tied to the page's
read/snapshot boundary, or a catch-up protocol that coalesces history before
declaring content current. Setting the cursor to whatever head exists
*after* rendering can miss events in the render-to-subscribe gap. Preserve
`Last-Event-ID` reconnect semantics and live changes during catch-up.

## Wider legacy-numbering impact

**Search silently omits PRs.** A live GET `/api/search` took **0.554 s**,
returned 200 and **89 entries**: 80 tickets, five pages, two projects and two
recipes. It returned **zero PR entries and an empty problems list**, despite
the seven existing PR streams established by the retest. The API calls
`readSearchPrs` (`apps/board/src/app/api/search/route.ts:52`), which reads
`prsOf` (`apps/board/src/lib/prs.ts:495`); the missing highest-number record
looks like legitimate empty history.

**Task attribution is false, not merely absent.** GET
`/task/ticket-lingtai-1439` returned 200 in **1.091 s**, but its rendered
content says **“no PR or draft holds it”**. Direct PR 7's page lists #1439
among its 30 tickets. `readOnBranch` uses the same PR/draft readers
(`apps/board/src/lib/prs.ts:468–:479`); empty reads become `Holder.none`
(`apps/board/src/lib/task.ts:908–:922`) and that definitive sentence
(`:1046–:1055`). Missing migration data should not be presented as proven
absence.

**Dependency release has the same exposure, inferred from source.**
`readDraftedTickets` loops only up to the recorded highest and returns an
empty set for null (`packages/project/src/pr.ts:307–:312`). In team-mode
discovery, `runnableNowEffect` uses this set to decide whether an open blocker
already landed on the personal branch
(`packages/conductor/src/discover.ts:664–:678`). A legacy project can therefore
fail to release a dependent whose open blocker already landed. No currently
runnable, unheld chain was exercised, so this is a confirmed code-path risk,
not a newly observed stuck ticket. Include this path when validating a fix
for the numbering gap; do not limit acceptance to the five PR columns.

## Empty results still trigger broad spend work

The preserved [1.997-second list witness](http://harbor:16686/trace/c75ee6d074e1ee606665d891d1323c41)
contains a **1.790-second `spend.read`** even though no PRs were listed.
`readPrPage` still calls `spendByPr` with an empty number array
(`apps/board/src/lib/prs.ts:174–:177`). `spendByPr` does not short-circuit:
it first reads every spend row for the project, then filters them in memory
(`:136–:144`). Postgres selects all columns and sorts by seq
(`packages/projector/src/postgres.ts:531–:553`).

An empty-input fast path avoids this work independently of the existing
61-call, 30-ticket detail issue. For a nonempty input, narrow the PR spend
read and batch/share ticket facts within the request. The existing spend port
already accepts a ticket array (`postgres.ts:534–:536`), so per-ticket round
trips are not an unavoidable storage constraint. Preserve unknown/unreported
cost behavior. Fix the missing PR history before calling an empty-list
speedup a complete performance acceptance result.

## Remaining evidence limits

- The homepage's preserved **3.355-second** witness finishes its last measured
  child about **1.594 seconds** before the root ends. That interval remains
  unattributed; #1442 and #1443 are still held and open. It cannot be assigned
  to SQL, React or browser paint from these spans alone.
- A fresh **22:50–23:13 UTC** query has no attributable HTTP roots; its 140
  `db.acquire` spans share an unexported parent and extend from an earlier
  long-lived trace. They are not 140 page requests or evidence of a new page
  latency regression. Background/stream activity is possible but not proven
  by this export.
- Single document checks: `/report?project=lingtai` **1.790 s / 200** and the
  task above **1.091 s / 200**, without a server-error page. These are one-off
  checks, not stable latency estimates. `/spend` returns 404, but is absent
  from current navigation/search and has been consolidated into report;
  it is not reported as a new navigation defect.
- The task response is **760,385 bytes**, with about **257,838 characters**
  of parsed non-script text. Browser rendering cost was not measured, so
  payload size is a candidate for profiling rather than a proven cause of
  perceived slowness.

[followup-findings.json](followup-findings.json) stores aggregate evidence,
probe limits and qualifications. No raw SSE bodies, task text, search entries,
credentials or connection URL are retained. No application code, event, issue
or service state was changed.
