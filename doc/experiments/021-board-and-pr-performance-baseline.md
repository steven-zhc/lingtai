# 021 — Board and PR performance before the draft reader changes

**Captured** 2026-11-24 at 16:00 CST · **Baseline window** 2026-11-24
00:00:00–16:00:10 CST · **Purpose** compare the running board before and after
[#1395](https://github.com/steven-zhc/lingtai/issues/1395) replaces the computed
PR draft. The old reader is visible in these traces: hundreds of ticket-stream
reads on each homepage or PR-board request. This is an observed-traffic
baseline, not a controlled load test.

## Frozen measurements

The archive contains **230 completed HTTP requests** across the board service's
routes. These are the primary comparison groups; direct GET and RSC navigation
or refresh are kept separate. Durations describe server request completion,
not first paint, and concurrent child durations must not be added as latency.

| Request | Samples | Median | P95 | Maximum | Median ticket reads under the PR reader |
|---|---:|---:|---:|---:|---:|
| Homepage RSC GET `/` | 92 | 48.687 s | 155.781 s | 195.773 s | 838 |
| Homepage direct GET `/` | 6 | 61.333 s | 122.051 s | 122.051 s | 836 |
| PR board RSC GET `/pr/[project]` | 107 | 40.290 s | 105.111 s | 200.633 s | 825 |
| PR board direct GET `/pr/[project]` | 3 | 57.456 s | 165.512 s | 165.512 s | 825 |

All four groups have HTTP 200 and no root OTLP ERROR in this sample. The direct
GET groups are too small for a stable tail estimate; their nearest-rank P95 is
their maximum. Route patterns do not identify the selected project or URL
filter. Project-specific attribution, browser count, active concurrency and
cold/warm state were not recorded, so a later before/after comparison must
report these limits rather than present the traffic as identical workloads.

## Durable witnesses

The selected span trees are saved locally, so the timing evidence survives a
Jaeger retention reset. Both contain the old full-history ticket-read path.

| Trace | Request start CST | Request | PR reader | Ticket reads under PR reader | Returned ticket events | Sum of those read durations |
|---|---|---:|---:|---:|---:|---:|
| [b720d69f0518f776b8152750678dac71](http://harbor:16686/trace/b720d69f0518f776b8152750678dac71) | 2026-11-24 14:59:05.376 | 195.773 s | `pr.landed-where` 185.925 s | 838 | 9,336 | 181.220 s |
| [c271de58554f5ae25bcb62b977a2cd1d](http://harbor:16686/trace/c271de58554f5ae25bcb62b977a2cd1d) | 2026-11-24 14:59:03.484 | 200.633 s | `pr.board` 195.267 s | 838 | 9,336 | 186.250 s |

In the homepage witness, `page /` took 11.258 s, `board.queue` 3.967 s and
`board.progress` 5.019 s. The PR-board witness has no GitHub request span and
its longest observed projection-pool acquisition is 0.563 s. The latter does
not measure the event store's separate pool.

The code examined in checkout `8fcffee0b8fd38a54d02e21614e7051f4d5e9d5d`
still used `readDraftOf` over all retained ticket rows
(`apps/board/src/lib/prs.ts:98`–`:115`) from both `readPrPage` (`:154`) and
`readLandedWhere` (`:206`). `readDraftOn` awaited one ticket read per candidate
before filtering it (`packages/project/src/pr.ts:704`–`:712`). The homepage's
Landed part invokes that reader at `apps/board/src/app/page.tsx:1120`.
The checkout revision records the analysis source, **not a proven running-board
revision**: the exported service resource had no deployment commit.

## Files and calculation

- [Per-request samples](021/before-1395/requests.csv): timestamps, request
  duration, method, route pattern, RSC flag, HTTP/OTLP status, observed read
  counts, and the longest observed span for each named stage. Missing stages
  are empty fields. A zero count without event-read instrumentation is not
  proof of zero reads; use `event_reads` and the summary's observed denominator.
- [Summary](021/before-1395/summary.json): exact unrounded aggregates for all
  route/method/RSC groups. Quantiles use nearest rank, `sorted[ceil(p*n)-1]`,
  over requests rather than over pre-aggregated intervals.
- [Provenance](021/before-1395/provenance.json): query parameters, export time,
  source hash, version uncertainty and comparison requirements.
- [Selected sanitized span trees](021/before-1395/witness-spans.json.gz): 1,856
  spans for the two witnesses, retaining ids, parentage, source timestamps,
  names and approved scalar measurement attributes. No event bodies, headers,
  free-text errors or full resource payloads are retained.
- [Cutover record](021/deployment-1395.json): deliberately unconfirmed until
  the effective running version is established.
- [The same reducer for the next sample](021/summarize.py): a standard-library
  reader for Jaeger's OTLP JSON export; it refuses to overwrite an output
  directory. The full 89 MB export is not added to the repository; the source
  SHA-256 is retained and baseline aggregates can be recomputed from the CSV.

The source query requested `lingtai-board`, raw traces, depth 10,000, between
2026-11-23T00:00:00Z and 2026-11-24T22:00:10Z. The frozen sample applies the
narrower local-day window stated above: request start must be in the window
and request end no later than its upper bound. This excludes older roots
returned because a child matched the query. Samples are an export of observed
completed requests, not proof that every request was captured.

## When the after window starts

The boundary is **when the board actually serves the fixed reader**. Record the
fix commit, landing time and board effective time separately, in UTC with an
explicit offset. A GitHub label, issue close, PR merge or daemon restart alone
does not establish the board's version. A board restart, deployment or confirmed
development hot reload can establish the effective boundary when tied to the
fixed revision. If old and new instances overlap, do not classify their mixed
traffic by timestamp alone.

At baseline archival time #1395 was OPEN with `lingtai:landed`; its observed
GitHub `updatedAt` was 2026-11-24T22:37:50Z (16:37:50 CST). That value is an
issue update, not an exact landing or board deployment time. The frozen trace
window ended before it. `board_effective_at_utc` remains null until confirmed.

After confirmation:

1. Fill the cutover record with the revision, effective time and evidence. Only
   requests **started after** that point belong in the after sample; exclude
   in-flight requests begun on the old version. Keep a first cold request
   separate from the warm sample, and record both window boundaries.
2. Open the same homepage/project filter and PR board. Keep environment,
   database, open pages and activity comparable where practical; record the
   actual draft size and historical ticket count. Prefer at least 30 requests
   per main group; if fewer are available, retain the sample size and avoid a
   strong P95 claim. Do not generate load against the running service just to
   fill the sample without deciding on that experiment separately.
3. Export traces and run the same reducer into a **new** directory, with explicit
   timestamps. Example, replacing both time placeholders and the export path:

   ```sh
   rtk proxy python3 doc/experiments/021/summarize.py /tmp/after-1395-otlp.json \
     doc/experiments/021/after-1395 \
     --start '<confirmed-after-sample-start-with-offset>' \
     --end '<after-sample-end-with-offset>'
   ```

4. Compare median, P95, maximum, error counts and request count by the same
   route/method/RSC groups. Report `after / before` and percentage reduction,
   alongside ticket reads under the PR reader and its span duration. The
   structural check is that reads scale with the actual draft rather than all
   historical tickets; it does not require zero ticket reads because draft
   ticket titles may still need to be loaded (#1395).
5. Confirm the new revision/path in the after evidence. A faster request alone
   does not prove that #1395 is running. Preserve this before directory and
   append after results without rewriting it.
