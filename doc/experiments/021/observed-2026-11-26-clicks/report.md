# Page request logs on November 26

The captured recent traffic still has multi-second tail latency. The clearest
current causes are serialized GitHub dependency reads in homepage queue
loading and broad/repeated spend reads on PR pages. Local queue selection is
no longer the dominant stage in the slow homepage witness. Some work continues
after request roots end, which needs response/cancellation attribution.

## Scope and runtime

**Window:** November 26 **16:30–18:36:30 CST**, equivalent to
2026-11-26T22:30:00Z–2026-11-27T00:36:30Z. The export has **239 completed
HTTP roots**, 253 traces and 26,604 spans. Three homepage roots end more than
100 ms before their children; exclude them from the **236-request primary
cohort**, retaining their work separately. All roots report 200 and there
are no exported OTLP ERROR spans. Neither fact proves that every UI result
is correct or every request completed in the browser.

The page is still production build
`b9f27c1157875e24168fc40d15007adcc991e720`, PID 22585, started November 25
at 15:13:49 CST, cwd `dist/board/apps/board`. Checkout `5fb7d27fd` adds the
previous experiment results. The service resource has no runtime SHA; the
process/build file corroborate the running version. [PR #1503](https://github.com/steven-zhc/lingtai/pull/1503)
from `steven-zhc/studio-pr-8` remains OPEN, so its newer code is not treated as
part of this running build.

The analysis reads existing Jaeger data, the process's text log and one
read-only numbering check. No browser or synthetic page probes were run;
these observations come from the existing traffic. The exporter filters spans
and records route patterns without browser navigation identity. This is all
captured data in the query window, not proof of every physical click or every
runtime operation. Clicks, prefetch and automatic refresh are mixed.

| Primary RSC GET group | Samples | Median | Descriptive P95 | Maximum |
|---|---:|---:|---:|---:|
| Homepage `/` | 27 | 2.495 s | 7.026 s | 7.846 s |
| PR list `/pr/[project]` | 104 | 0.784 s | 1.721 s | 6.026 s |
| PR detail `/pr/[project]/[n]` | 92 | 1.427 s | 2.803 s | 3.532 s |

Homepage tail quantiles have only 27 primary samples. The PR-list cohort
also has different workloads: 92 requests have zero observed draft-ticket
reads (median 0.748 s, max 6.026 s), and 12 have 36 (median 1.492 s,
max 1.721 s). Zero draft-ticket reads is not proof of an empty PR history.
Route patterns do not identify the project or distinguish numbered and Next
detail pages, so do not treat all page responses as equal workloads.

## Homepage queue loading serializes dependency reads

[The 7.846-second witness](http://harbor:16686/trace/764892ecb04660f7aadc7bddba04a27c)
starts local page work promptly. `page /` finishes in **0.688 s**, but queue
loading lasts **7.486 s**. Inside that path:

| Stage | Duration |
|---|---:|
| `queue.list` | 7.161 s |
| Eleven sequential GitHub requests under that list, summed | 5.552 s |
| Project plus eight PR event reads under that list, summed | 1.604 s |
| `queue.look` | 0.172 s |
| `queue.select` | 0.043 s |
| `queue.explain` | 0.110 s |

The GitHub and event-read calls in this particular list execute sequentially,
so their sums account for nearly all of its 7.161 s. Concurrent phase totals
elsewhere must not be added this way. The longest projection acquisition
anywhere in the witness is only **9 ms**.

Source matches the timing: `runnableNowEffect` first lists open issues
(`packages/conductor/src/discover.ts:605–:608`), then loops over them
(`:616`). An eligible dependency-held issue awaits `listBlockedBy`
(`:642–:648`). The first successful blocker response also awaits
`readDraftedTickets` (`:664–:669`), whose PR-stream reads are serial
(`packages/project/src/pr.ts:307–:312`). Thus more dependency-held tickets
add serial remote calls, and the historical PR read sits between them.

The next [7.026-second request](http://harbor:16686/trace/9816cdc40306f3cd8a6e51c079a2f7e3)
begins 0.810 s later and overlaps this work. Its queue list takes **5.533 s**
with seven GitHub calls. The blocker cache stores completed answers for 60 s,
but no pending promise (`packages/conductor/src/blockers.ts:29–:31`,
`:105–:126`). Concurrent misses can therefore duplicate outstanding work.
Exported spans omit endpoint/issue IDs, so this export alone cannot prove
which individual blocker request was duplicated across the two traces.

Priorities: bound parallel dependency reads while preserving output/order and
failure rules; share in-flight reads for the same cache key; and reuse the
request's PR facts rather than serially rereading all historical PR streams
under queue discovery. Do not change blocker/admission semantics or assume a
larger pool solves these network waits. The historical 2.16-second local
selection issue is not the current cause: selection is 43 ms here.

## PR list waits on project-wide spend

[The 6.026-second list witness](http://harbor:16686/trace/d6af516893f44477e926fd596eee3c24)
has **zero GitHub requests**. Its PR reader starts at 16 ms, recipe resolution
takes 28 ms, and draft reading takes **0.908 s**. Then `spend.read` begins at
1.263 s and lasts **4.758 s**. Observed projection acquisition is at most
**4.312 ms**; the acquisition beneath spending is effectively immediate.

`spendByPr` reads every spend row for the project before filtering for the
requested PR numbers (`apps/board/src/lib/prs.ts:135–:144`). The Postgres
reader selects all columns and sorts by sequence
(`packages/projector/src/postgres.ts:531–:553`). Narrow that read to the
needed PR stream IDs and avoid an empty-input read. The span includes
query/result transfer/decoding, so it is not evidence that SQL execution
itself took all 4.758 s; add that distinction before deciding on an index.

## PR detail repeats spend reads and fans out to GitHub

[The 3.532-second detail witness](http://harbor:16686/trace/932461439da893cc28c9103c14cfd70b)
contains **73 spend reads, 74 projection acquisitions and 37 GitHub requests**.
The main `pr.detail` starts at **1 ms** and finishes at about **0.998 s**.
The streamed host/generated parts then continue to **3.532 s**; two GitHub
calls take **1.843 s** and **2.345 s**, while most take roughly 0.3–0.5 s.
This separates useful main-data readiness from total response completion.
No browser paint or click-to-ready metric was captured.

The counts match the existing 36-ticket pattern: `ticketFacts` performs one
spend read per ticket with unbounded concurrency
(`apps/board/src/lib/prs.ts:274–:306`), is called by both the main detail
(`:370–:374`) and generated description (`:443–:447`), and adds the PR's own
project-wide spend read (`:375`). This repeats 36 ticket spend reads twice,
plus one own-spend query. Generated content also asks GitHub about each
ticket; an open host PR adds another host-state request.

Batch and share log-backed spend facts within a request, keeping unknown cost
semantics; keep host answers deferred. Limit remote fanout or batch supported
host queries rather than moving them ahead of the main content. The pool
waits are visible consequences of many operations, not proof that the pool
size is the appropriate first change.

## Requests end while their work continues

| Trace | Root duration | Child work beyond root end |
|---|---:|---:|
| [5cbaf7f36a4b520347ceef9494160bf5](http://harbor:16686/trace/5cbaf7f36a4b520347ceef9494160bf5) | 1.360 s | 3.960 s |
| [cf2c07986c49f171431edb236a38d6de](http://harbor:16686/trace/cf2c07986c49f171431edb236a38d6de) | 2.834 s | 5.626 s |
| [72bb8ab34dc092d695ad8abe0fb15e87](http://harbor:16686/trace/72bb8ab34dc092d695ad8abe0fb15e87) | 2.075 s | 3.141 s |

These include operations newly started *after* the root ends: respectively
10, 10 and nine GitHub requests, plus database work. They are excluded from
primary latency statistics but not from the record of resource use. The root
end alone does not prove browser cancellation; finish/close and abort signals
are needed to distinguish navigation interruption from span-lifetime issues.
If cancellation is confirmed, propagate it into queued/deferred work, while
preserving already-started side effects and shared in-flight read ownership.
This analysis changes no cancellation behavior.

The running process writes stdout/stderr to `~/.lingtai/board-prod.log`.
Its captured lifetime log has 17 **“The destination stream closed early”**
messages and two idle projection-connection drops. These lines have no
timestamps and span the process's lifetime, so they cannot be counted as 17
failures within this window or individually linked to the three traces.
The timing entries are thresholded slow-read logs, not an unbiased request
sample; do not compute page quantiles from them.

There are bursts of requests: **30 roots in 18:29 CST**, and an observed
peak of **four overlapping HTTP roots at 18:35:33.618 CST**. Browser/session
and navigation identity are absent, so these are not counts of distinct user
clicks. Existing live-update replay, refresh and prefetch can contribute;
this export does not attribute the bursts to one of them.

## Previously missing PR history has recovered for lingtai

The read-only check at 2026-11-27T00:39:23Z now finds
`ProjectPrNumbered { n: 8 }` on `prj-lingtai`, seq 66325, recorded at
**November 25 17:43:16 CST**. The project is version 32. PR 7 now has a
`PrMerged` event (49 events total), and PR 8 exists (60 events). This is the
expected next-write initialization after the earlier legacy gap. It does
not prove a general migration mechanism was added, but the old missing record
and stale PR 7 state must not be reported as still present in this project.

## Archive and limits

- [requests.csv](requests.csv) and [summary.json](summary.json): all 239
  roots, method/route/RSC groups and source hash, from the shared reducer.
- [analysis.json](analysis.json): primary 236-request aggregates, exclusions,
  stage maxima and different draft-read workloads. Stage quantiles are not
  additive and can come from different requests.
- [text-log-summary.json](text-log-summary.json): safe timing/error counts
  and file metadata, without raw runtime messages, headers or credentials.
- [numbering-check.json](numbering-check.json): safe state/count evidence.
- [witness-spans.json.gz](witness-spans.json.gz): 944 sanitized spans from
  seven witnesses, all with retained parentage; no event bodies or error text.
- [provenance.json](provenance.json) and [checksums.json](checksums.json):
  query/runtime evidence, method limitations and integrity hashes.

No application code, production events, services, issues or PRs were changed.
This is an observed-traffic diagnosis, with no extra user-facing page load.
