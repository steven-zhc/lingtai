# Production page performance on November 25

The recent production traffic is substantially faster than the November 24
development cohorts. PR-list content now starts alongside its header. The
most actionable remaining paths are the PR-detail header waterfall and the
homepage queue selector's broad historical task read. Some slow requests
still contain unmeasured intervals that need attribution before a fix.

## Runtime and sample

The page process, PID 69841, started at **2026-11-25 00:39:02 CST**. Its cwd is
`dist/board/apps/board`; its parent runs `pnpm lingtai board start --no-open`.
The standalone build ID and current checkout both name
`b95689564cf72a757fa57a76c65d5381e7529c02`. This corroborates a production
build; the exported resource still has only `service.name`, without a runtime
commit attribute.

The query covers **07:00–08:50 CST / 13:00–14:50 UTC** on November 25.
There are 458 completed HTTP request roots and one root crossing the upper
boundary. Two roots end more than 100 ms before their children; they are
retained in the raw data and excluded from the 456-request primary cohort.
Cancellation/context timing is unresolved for these two requests.

| RSC GET route | Primary samples | Median | P95 | Maximum |
|---|---:|---:|---:|---:|
| Homepage `/` | 312 | 1.887 s | 3.115 s | 5.107 s |
| PR list `/pr/[project]` | 22 | 1.371 s | 1.864 s | 2.831 s |
| PR detail `/pr/[project]/[n]` | 56 | 1.070 s | 2.350 s | 3.632 s |
| Task `/task/[id]` | 33 | 1.469 s | 2.483 s | 2.487 s |

All 458 HTTP roots report 200 and no root OTLP ERROR. A 200 does not prove
that every deferred part succeeded. In particular, 33 `prompt.template` spans
are ERROR; their messages are not exported and they do not account for the
large waits discussed here. PR-list P95 is descriptive with only 22 samples.
These durations measure server request completion, not browser click-to-paint.

The November 24 post-1395 cohorts had homepage RSC median 6.240 s (n=5) and
later PR-list RSC median 17.070 s (n=5). The current traffic has different
activity, draft sizes and unknown concurrency, and runs in production rather
than development mode. The observed difference is not a controlled estimate
of the contribution from any single change.

## Improvements confirmed in the traces

PR-list `pr.board` now starts at median **3 ms**, maximum **9 ms**, after its
request. The prior 13–15-second delay before that reader starts is absent.
This matches `apps/board/src/app/pr/[project]/page.tsx:68–:83`, which starts
the body load before awaiting the independent header reads together.

Every current PR-list RSC request has six PR-stream reads, rather than the
previous 15 reads over five PRs. The current project has different PR history;
the source now shares stream promises within a request and reads PR chunks
and draft titles with bounded concurrency. See
`apps/board/src/lib/request-store.ts:47–:63`, `apps/board/src/lib/prs.ts:84–:86`
and `:160–:163`. Each current PR-list request has four draft ticket reads.
The reduction from the previous draft's 21 tickets is workload change as well
as code change; it is not a 21-to-four optimization claim.

## Remaining priorities

### PR detail still waits for the header before starting content

Across 56 RSC detail requests, `pr.detail` starts at median **0.813 s**,
P95 **1.539 s**, maximum **1.578 s**. Its own median duration is only
**0.204 s**. Unlike the PR list, the detail route still awaits registered
projects, then onboard projects, then locks and view counts before returning
the Detail subtree. Its Suspense fallback is `null`.

In [the 3.632-second detail witness](http://harbor:16686/trace/eb49f743a383fba5f77f5d7f42b855de),
the detail reader starts at **1.578 s** and finishes at **3.042 s**;
deferred GitHub work then runs until about **3.631 s**. Header/content overlap
can remove avoidable serial waiting, but does not guarantee subtracting the
whole 1.578 seconds from every request. Apply the PR list's early body start
and independent header reads here, with a visible detail fallback. Preserve
its invalid-route and unreadable-project behavior. Source:
`apps/board/src/app/pr/[project]/[n]/page.tsx:27–:29`, `:78–:109`.

### Homepage queue selection reads far more task state than its decision needs

For the 312 primary homepage RSC requests, `queue.list` median/P95 is
**0.625/0.793 s**; the subsequent local `queue.select` is
**0.523/1.344 s**, maximum **2.156 s**. In
[the slow queue witness](http://harbor:16686/trace/7586ea73d67784a403b62dd6c8ecd2f9),
the whole request is **4.513 s** and queue loading is **3.584 s**:
listing **0.625 s**, local look **0.101 s**, selection **2.156 s** and
explanation **0.702 s**. These measured phases run in sequence; this tail
cannot be assigned to GitHub alone.

The selector calls `readTasks` with **36,500 days** of retention, constructs
full cards, then uses a small subset of fields to filter the offered issues.
Postgres executes `select t.*` with sorting and maps every returned card.
See `packages/conductor/src/queue.ts:87–:113` and
`packages/projector/src/postgres.ts:445–:465`. A targeted read for offered
issue references and the fields needed for state/backoff is a useful next
experiment. It must retain the existence/state of old closed issues: simply
reusing the visible board's short retention window would admit previously
finished tickets. Separate pool wait, query/transfer and card conversion
measurements before deciding on indexes or pool size. The current phase does
not distinguish those costs.

The homepage also degrades later in the window: 07:00–08:35 CST median/P95
**1.841/2.519 s** (n=273), versus 08:35–08:50 **2.927/4.530 s** (n=39).
Queue median rises from **1.275 s** to **2.065 s**. This is an observed shift
under changing activity, not proof of a leak or a concurrency cause.

### PR number discovery remains sequential and partly unmeasured

The 2.831-second [PR-list witness](http://harbor:16686/trace/6aa5f0b873a0ec466318769434422277)
starts its reader immediately, but its first PR event reads begin at **1.256 s**.
The project event read ended around **0.122 s**. After the last measured
acquisition near **1.676 s**, the reader finishes around **2.829 s**.
These intervals are not explained by the exported event-read spans.

`topPrNumber` and `listTailPrs` still discover the highest PR by awaiting
`head(1)`, `head(2)`, and so on until an absent stream. Request memoization
shares these calls; their cold sequence still grows with PR count. Source:
`apps/board/src/lib/prs.ts:43–:51`,
`packages/project/src/pr.ts:105–:112`. `EventStore.head` is a database query
(`packages/event-store/src/event-store.ts:569–:577`), but no `events.head`
measurement leaves in this export. Add phases for number discovery, recipe
resolution and spend reads before assigning the witness's gaps to one cause.
If the head walk dominates, replace the linear discovery while preserving
exact project identity and the latest-stream rule.

### Retain visibility into response completion and late lock reads

The [5.107-second homepage witness](http://harbor:16686/trace/2363229aeb386dc3fc844b9493d57704)
finishes its last exported child at **2.922 s**, leaving **2.185 s** before
the HTTP root ends. Across the homepage sample this tail has median
**0.001 s**, P95 **0.252 s**. Existing instrumentation explicitly leaves RSC
Flight rendering, response delivery/backpressure and disconnects unmeasured
(`apps/board/src/lib/telemetry.ts:24–:36`). This isolated large tail requires
response `finish`/`close` and browser route/content-ready measurements, not
another inferred database fix. PR routes also lack the exported Next phases
allowed for homepage/task routes (`:64–:70`).

Task pages have a smaller, directly avoidable final wait. In
[the 2.487-second task witness](http://harbor:16686/trace/9034b2d2e46887df0693352c3d5329c9),
`page /task locks` starts at **2.008 s** and lasts **0.474 s**. The layout
awaits `loadTask` before starting `pauseSlot`; start that independent read
earlier once project identity is known. See
`apps/board/src/app/task/[id]/layout.tsx` at the final TaskLayout await chain.

## Reproducible archive

- [requests.csv](requests.csv) and [summary.json](summary.json): all 458 roots,
  using the unchanged shared reducer and separate method/route/RSC groups.
- [analysis.json](analysis.json): the 456-request primary cohort, explicit
  exclusions, per-request stage maxima and timing offsets. Stage quantiles
  describe different requests and must not be added together.
- [provenance.json](provenance.json): query, source hash, runtime/build evidence
  and comparison limits.
- [witness-spans.json.gz](witness-spans.json.gz): 663 sanitized spans from ten
  witnesses, including both quality exclusions. Their parents are present;
  no event bodies, request headers or free-text errors are retained.
- [checksums.json](checksums.json): archive integrity hashes.

No service was restarted, no synthetic load was generated, and no application
code was changed. Earlier cohorts remain unchanged.

## Follow-up queue read diagnostic and tickets

At the operator's request, a separate read-only diagnostic ran at
**15:00–15:01 UTC / 09:00–09:01 CST**. It issued a small number of serial
queries on a connected client, not a concurrent load test or replay of the
earlier 2.156-second request. The original witness's acquisition beneath
`queue.select` took **3.516 ms**; pool wait alone does not explain that span.

| Query shape | Rows | Serialized decoded-row bytes | Query, transfer and pg decoding, three observations |
|---|---:|---:|---|
| Full cards, original sort | 892 | 3,671,178 | 536.4, 267.4, 200.5 ms |
| Four state/backoff fields, no sort | 892 | 90,511 | 12.3, 16.9, 19.9 ms |
| Full cards, no sort | 892 | about 3,671,440 | 521.1, 346.2, 337.6 ms |
| Four fields, original sort | 892 | 90,511 | 99.7, 16.1, 12.6 ms |
| Four fields, ten-reference fixture | 10 | 1,025 | 7.5, 95.0, 5.7 ms |

The original query's `EXPLAIN ANALYZE` execution was **5.736 ms**, including
an in-memory sort; the narrow all-state query was **0.863 ms**. This server
execution time does not include result transfer, pg decoding or full-card
conversion. The JSON byte count is a serialization of already-decoded rows,
not PostgreSQL wire bytes. The queries run at different instants, without a
frozen database snapshot; the ten references are a fixture, not the original
GitHub offer. Full-card `toCard` conversion was not separately timed here.

The controls show a substantial cost from full-record results independently
of the sort. They do not account for every millisecond of the older 2.156 s
under different activity. The next change should narrow the queue read and
retain acquire/query-transfer-decode/conversion attribution, rather than
assume an index or a larger pool is the answer. Aggregate results and safe
execution plans are in [queue-read-comparison.json](queue-read-comparison.json);
no row bodies or credentials are retained.

Five independent tickets were created, assigned to `steven-zhc`, and read
back against the intended requirements. Each has a kind label and
`lingtai:hold`; none is released for execution by this analysis.

| Ticket | Scope |
|---|---|
| [#1439](https://github.com/steven-zhc/lingtai/issues/1439) | Start PR detail alongside navigation reads; preserve rejected-promise and route/error behavior. |
| [#1440](https://github.com/steven-zhc/lingtai/issues/1440) | Narrow queue lookup to offered references and state/backoff fields, preserving historical finished-task exclusion in both stores; retain phase attribution. |
| [#1441](https://github.com/steven-zhc/lingtai/issues/1441) | Attribute actual PR head reads, number discovery, recipe and spend waits without changing algorithms or request sharing. |
| [#1442](https://github.com/steven-zhc/lingtai/issues/1442) | Measure server response finish versus premature close, with bounded request ownership and safe phase export on PR routes. |
| [#1443](https://github.com/steven-zhc/lingtai/issues/1443) | Add an opt-in local browser benchmark for click/route start, loading feedback and destination main/deferred content readiness; no RUM service. |

[tickets.json](tickets.json) records the checked labels, owners and creation
times. No hard dependency is needed: browser measurements can describe the
current behavior before the fixes, and the server/head measurements can be
implemented independently. Requirements explicitly retain failure semantics,
telemetry privacy, bounded cleanup and the repository's unit/typecheck gates.
