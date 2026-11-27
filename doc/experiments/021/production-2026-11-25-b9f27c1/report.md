# Production retest of build b9f27c1

**Result: partial performance improvement, functional acceptance blocked.**
PR-detail reading starts immediately and empty-offer queue selection avoids
the historical full-card query. However, the PR list displays all five
columns as zero while seven historical PR streams still exist. Its faster
empty response is not a valid performance acceptance result. A direct PR 7
page still shows In review although GitHub has already merged it.

## Version and method

- Production standalone build and checkout:
  `b9f27c1157875e24168fc40d15007adcc991e720`.
- Page PID 22585, parent 22555, started **15:13:49 CST / 21:13:49 UTC**;
  cwd `dist/board/apps/board`, parent command
  `pnpm lingtai board start --no-open`. The build file corroborates the
  version; the OTLP resource still has no runtime-commit attribute.
- The initial **21:30–22:42 UTC** natural-traffic query contains only one PR
  RSC root and one footer root. It is insufficient for performance conclusions.
- Five serial document GETs and five serial synthetic RSC GETs per target:
  homepage filtered to lingtai, PR list, PR 7 and Next PR. All 40 completed
  probes return 200 with the expected HTML or RSC content type. Five samples
  per target/mode do not establish a stable P95.
- Synthetic RSC uses `RSC: 1`, omits browser router-state headers and follows
  one Next normalization redirect. Twenty earlier redirect-only probes are
  explicitly excluded, rather than counted as millisecond page successes.
  Curl first-byte values in these redirected probes must not be interpreted
  as the destination page's first byte.
- Browser verification navigated homepage → PR list, then directly to the
  confirmed historical PR 7. The temporary browser was closed afterwards.
  Its Follow/prefetch traffic and other activity overlap some probes: serial
  describes the probe script, not controlled global concurrency. Browser
  actions verify visible content, not click-to-ready timing.
- The test-window trace export, **22:42:00–22:47:24 UTC / 16:42:00–16:47:24
  CST**, contains 121 completed HTTP roots including automatic browser
  activity. All report 200 with no root OTLP error; no root has children
  ending more than 100 ms later. HTTP status alone misses the functional
  failure below.

## Client request measurements

These are five-request medians and ranges of full-response client time.
RSC is synthetic and not a browser visual readiness measurement.

| Target | Document GET median / range | Synthetic RSC median / range | Correctness qualification |
|---|---:|---:|---|
| Homepage | 1.100 s / 0.989–1.274 | 2.433 s / 1.012–2.650 | Historical landed-to-PR attribution is affected by the numbering gap. |
| PR list | 0.585 s / 0.419–0.807 | 0.900 s / 0.465–1.581 | All columns zero despite existing streams; not a comparable success. |
| PR 7 | 1.265 s / 1.222–1.476 | 2.476 s / 1.209–3.110 | Main data renders; lifecycle state is stale and 30-ticket spend reads remain costly. |
| Next PR | 0.258 s / 0.230–0.349 | 0.267 s / 0.171–0.470 | No recorded highest PR, so empty output is not a complete-history acceptance case. |

The prior November 25 morning cohort mixed other numeric PRs and Next pages,
had different draft sizes/activity, and did not measure the same controlled
targets. Do not present these medians as a causal before/after percentage.

## Blocking legacy-numbering gap

At **22:44:38 UTC**, a read-only database check found:

- `prj-lingtai` has version 31 and **zero `ProjectPrNumbered` events**.
- Exact streams `pr-lingtai-1` through `pr-lingtai-7` contain respectively
  **18, 19, 19, 19, 52, 20 and 47 events**. PRs 1–6 each have a `PrMerged`
  event; PR 7 has none.
- The browser's PR list shows Draft 0, In progress 0, Waiting on you 0,
  In review 0 and Merged 0. Direct PR 7 renders 30 tickets and its history,
  confirming that the records have not disappeared.
- [GitHub PR #1465](https://github.com/steven-zhc/lingtai/pull/1465), branch
  `steven-zhc/studio-pr-7`, merged at **21:08:11 UTC / 15:08:11 CST**, with
  the current build's merge commit. Around 22:47 UTC the detail page still
  says In review, while its deferred host line says merged on GitHub and
  promises Lingtai will record it within five minutes.

The cause of the empty list is confirmed by source: `highestPr` folds only
the project's recorded number (`packages/project/src/pr.ts:91–:99`);
`listPrs` returns an empty list for null (`:117–:120`), and `listTailPrs`
starts at zero (`:185–:190`). The board uses the same null-to-zero boundary
in `apps/board/src/lib/prs.ts:70`.

This behavior is explicitly allowed by the new ADR:
`doc/decisions/0131-a-pr-goes-from-draft-to-merged.md:45–:51` defers discovery
of old numbers until the next write and says readers see no PRs before then.
It therefore matches the new rule but leaves existing deployments without
a completed migration. `numberingOf`'s probing and `numberBatch` repair are
writer-only (`packages/project/src/pr.ts:135–:176`); merely opening a page
does not trigger them.

The same boundary also affects reconciliation: `learnPrEnds` first calls
`openPr` and later `listPrs` (`packages/conductor/src/pr.ts:1394–:1409`).
With no recorded highest these readers find no PR to learn or finish. This
source path is consistent with PR 7's observed stale lifecycle state; no
claim is made that a particular sweep invocation was traced here. A safe,
explicit legacy-number initialization or compatibility path is needed before
accepting the list and merge-following behavior. No event was appended or
manual database repair attempted during testing.

## Improvements and remaining performance work

**PR-detail overlap works.** Across 26 numeric/Next detail roots in the test
window, `pr.detail` starts at median **3 ms**, maximum **14 ms**. The prior
morning sample started at median 813 ms. The new start seam is verified,
independently of differences in complete request duration or payload.
`apps/board/src/app/pr/[project]/[n]/page.tsx` now starts the load before
awaiting independent bar inputs and passes that promise into Detail.

**Empty-offer queue selection is cheap.** Across 35 homepage roots,
`queue.select` median is about **0.1 ms**, maximum **0.5 ms**. The current
queue has no runnable offer; `readTaskStatesEffect`'s empty-input fast path
avoids a database read. This validates that case, not a nonempty candidate
query under load. The narrow query exists at
`packages/projector/src/postgres.ts:476–:489`; current queue listing still
takes median **0.425 s**, maximum **0.967 s**.

**New phases identify repeated spend reads.** In the
[3.108-second PR-detail trace](http://harbor:16686/trace/365f2d0255138c75315c1c37a10f7989),
there are **61 `spend.read`**, **62 projection acquisitions**, **31 GitHub
requests**, and seven event reads. `pr.detail` starts at 2 ms and lasts
2.254 s. Thirty ticket spend reads start around 0.499 s; then the project-wide
spend read starts at 0.973 s and lasts **1.280 s**. After the main detail is
ready around 2.256 s, the generated description repeats the 30 ticket spend
reads while asking GitHub about those tickets.

`ticketFacts` calls `readSpendEffect` per ticket with unbounded concurrency
(`apps/board/src/lib/prs.ts:274–:306`). Both the main detail (`:370–:374`)
and generated description (`:443–:447`) call it. `spendByPr` asks for every
spend row in the project and filters for the named PR afterwards (`:136–:144`),
even when only one PR is wanted. These boundaries support batching the needed
ticket/PR spend reads and sharing the request's log-backed facts between main
and generated sections, while preserving unknown-spend semantics and deferred
GitHub answers. They do not support a global stale cache or blindly increasing
the projection pool.

Even the empty PR list still pays a project-wide spend query: in
[the 1.997-second list witness](http://harbor:16686/trace/c75ee6d074e1ee606665d891d1323c41),
`spend.read` alone takes **1.790 s**. Avoiding an empty-list query is useful,
but restoring the missing PR list must come first in correctness validation.

The remaining measurement tickets #1442 and #1443 are still OPEN with
`lingtai:hold`. They are not part of this build, so response finish versus
close and true browser click-to-content readiness remain unmeasured. Their
holds and other issue state were not changed by this retest.

## Validation and archive

Focused unit checks passed: **5 files, 24 tests**, covering PR-detail loading,
request-scoped reads, narrow task-state reads and queue ranking. Command:

```sh
rtk proxy env HOME=/nonexistent pnpm exec vitest run --project unit \
  apps/board/unit/pr-detail-page.test.tsx \
  apps/board/unit/request-reads.test.ts \
  packages/projector/unit/task-states.test.ts \
  packages/projector/unit/read-task-states.test.ts \
  packages/conductor/unit/queue-pr-fix.test.ts
```

Unit success does not validate migration of this live legacy project. No
application source, service lifecycle, issue label or production event was
changed. The checks generated only read requests and local diagnostic files.

- [Client checks](client-checks.json): separate document/RSC probes and the
  excluded redirect-only attempts, with timestamps and response validation.
- [Request CSV](requests.csv) and [summary](summary.json): all 121 observed
  roots; the raw route-pattern summary intentionally combines numeric/Next
  details, so use named client targets for that distinction.
- [Analysis](analysis.json): stage statistics, detail-start offsets and the
  slow detail's operation counts.
- [Numbering check](pr-numbering-check.json): aggregate read-only evidence,
  without event bodies or credentials.
- [Provenance](provenance.json) and [sanitized witnesses](witness-spans.json.gz):
  build/process evidence, method limits and 306 spans from four witnesses.
- [Checksums](checksums.json): artifact hashes. Earlier cohorts are unchanged.

The [subsequent follow-up](followup-findings.md) confirms missing PRs in
search, false task-to-PR attribution, and fresh SSE subscriptions replaying
from event zero (4,514 historical append frames / 512 KiB before the bounded
probe stopped). It also records dependency-release exposure and the
empty-list spend-query fast path, with observed versus inferred findings
kept distinct.
