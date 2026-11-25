# Initial board and PR measurements after 1395

**Window:** 2026-11-24 17:42:35–17:49:00 CST
(23:42:35–23:49:00 UTC). This contains 11 completed request-root spans after the
new page process started. Nine enter the primary descriptive comparison;
the first observed homepage request and one request with late-running children
are kept separately. The [before baseline](../../021-board-and-pr-performance-baseline.md)
is unchanged.

## Version and time evidence

- Fix commit: `2b65ddc02e067b692df7b015a44f40a4c5f853df`, reachable from `main`.
- [PR #1416](https://github.com/steven-zhc/lingtai/pull/1416) merged at
  **17:40:45 CST**, merge commit `8d035e54961750e39c6d560adc8464a829f1a153`.
- Page PID 25614 started **17:42:35 CST**; its cwd was this checkout's
  `apps/board`, listening on port 17820. The checked-out revision was
  `6a7452a34fba084d8048ee1f96e49adddc23bfa5`. The resource still lacks a
  runtime-commit attribute, so the first new-process trace and changed read
  behavior corroborate the user-confirmed switch rather than a version header.
- Daemon shutdown request: **17:42:42.238 CST**, seq **63013**. Its new
  `ConductorStarted` is **17:48:53.255 CST**, seq **63014**, at revision
  `6a7452a34fba084d8048ee1f96e49adddc23bfa5`. Before that event, its latest
  recorded start was at the older baseline checkout. Most page samples here
  therefore precede completion of the daemon's drain.

The [cutover record](../deployment-1395.json) retains all three times and the
evidence. Page samples use the new page-process boundary, not the later daemon
start or the issue's label-update time.

## Initial comparison

Same request method, route pattern and RSC flag; nearest-rank quantiles as in
the baseline. Values below describe request completion, not first paint.

| Request group | Before median / samples | After observations | After median / samples |
|---|---:|---|---:|
| Homepage RSC GET `/` | 48.687 s / 92 | 3.133, 3.985, 6.240, 8.618, 8.760 s | 6.240 s / 5 |
| Homepage direct GET `/` | 61.333 s / 6 | 4.032, 6.144 s | 4.032 s / 2 |
| PR board direct GET `/pr/[project]` | 57.456 s / 3 | 3.343, 5.124 s | 3.343 s / 2 |

The homepage RSC median is about **87% lower** in these observations. Every
after group is too small for a stable P95; the archive retains descriptive P95
values for reproducibility, not as a tail-performance claim. There are **no PR
RSC samples** in this window, so a PR RSC before/after comparison is not made.
The PR GET samples are two ordinary serial verification requests made by the
assistant, not load tests. Their client-side totals were 5.135 s and 3.347 s;
first byte was 2.481 s and 1.220 s respectively. Cold/warm state is not proven.

Per-request PR-related ticket reads have fallen to **21** in all 11 archived
requests. The before medians were **838** for homepage RSC and **825** for PR
direct GET. The reduction in reads is the stronger structural evidence: page
loading no longer scans roughly 800 historical ticket streams. Current reads
return 271 ticket events in each witness below, rather than 9,336 in the two
before witnesses. These totals depend on the actual draft content and are not
a requirement that future drafts always have 21 tickets.

## Witnesses and exclusions

| Trace | Request | Relevant PR reader | PR ticket reads |
|---|---:|---:|---:|
| [d9ac59cfc94605403c0c3099515b8f42](http://harbor:16686/trace/d9ac59cfc94605403c0c3099515b8f42), homepage RSC at 17:48:53 | 3.985 s | `pr.landed-where` 2.508 s | 21 |
| [df9fb27b70d60c79220b631da636ea95](http://harbor:16686/trace/df9fb27b70d60c79220b631da636ea95), first PR verification | 5.124 s | `pr.board` 2.632 s | 21 |
| [546a186cef6c758509d595e7b82ff4df](http://harbor:16686/trace/546a186cef6c758509d595e7b82ff4df), second PR verification | 3.343 s | `pr.board` 2.093 s | 21 |

The first observed homepage GET, `d541b61052f4364f86cc1ab140c4e1d9`, started
at **17:42:38.598 CST** and took **7.830 s**, with 21 PR ticket reads. It is
retained as the first-request cohort rather than asserted to be a known cold
start.

`5c62386c35a6d29b447b9b16f60748d0` has a request span of 1.924 s but measured
children continue about **5.1 s beyond that root's end**. It remains in the raw
request CSV/summary, with a flag in [request-quality.json](request-quality.json),
and is excluded from the primary comparison. Cancellation or context timing
has not been resolved; treating that 1.924 s as a normal completed page would
understate its work. The quality rule flags children ending more than 100 ms
after the request. The baseline stays frozen; these additional after-cohort
exclusions are explicit in [comparison.json](comparison.json).

## Archive and next sample

[requests.csv](requests.csv) and [summary.json](summary.json) contain all 11
request-root observations. [comparison.json](comparison.json) specifies the
9-request primary cohort, exact values, before/after ratios and exclusions.
[provenance.json](provenance.json) records collection details; the
[sanitized witness archive](witness-spans.json.gz) contains 557 spans, including
the first request and the flagged request. [checksums.json](checksums.json)
supports later integrity checks.

The two PR witnesses each retain 12 spans whose parents were filtered by the
selective exporter. The archive preserves their actual source parentage;
the per-trace counts are recorded in provenance rather than inventing parents.

The before archive's JSON and compressed witnesses match their original hashes.
Git normalized its CSV from the export's CRLF to LF on checkout; restoring CRLF
reproduces the original CSV hash exactly. Its records and values are unchanged.
New CSV exports explicitly use LF, so their recorded checksums survive the
same checkout normalization.

A later, longer window should be stored separately after the daemon's
**17:48:53.255 CST** start, allowing its background workload to settle and
matching project/filter/activity as far as possible. Natural traffic here has
different draft sizes and unknown concurrency, so the observed improvements
are not a controlled causal estimate. No extra concurrent load was generated
to reach a target sample count, and no service was restarted by this analysis.

The later [navigation sample](../after-1395-navigation/report.md), collected
after the daemon start, includes PR RSC requests taking **17–27 seconds**.
It confirms remaining two-stage waits. The two faster direct GET checks above
must not be generalized to ordinary PR navigation.

## Development-mode qualification

The live page process was confirmed as `next dev --turbopack`, launched through
`node ./serve.ts dev`, on port 17820. These observations are development-mode
measurements. Before attributing all remaining latency to application reads,
repeat the same PR navigation using a freshly built production board. The
serialized reads above are measured, but the development-mode contribution
to their absolute durations has not been isolated. Record the new process
start, build revision and production sample in a separate cohort.
