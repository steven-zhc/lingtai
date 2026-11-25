# PR navigation after 1395: remaining two-stage delay

**Window:** 2026-11-24 17:49–17:54 CST (23:49–23:54 UTC), after daemon
start seq 63014 at 17:48:53.255 CST. This natural-traffic sample follows the
user's report of waiting for the PR page, then waiting again for its contents.
The page is still too slow despite the removal of the historical-ticket scan.

## Observed requests

There are 16 completed HTTP request roots: nine homepage RSC requests, two
footer requests and five PR-board RSC requests. The five PR requests take
**17.070, 27.013, 26.096, 8.783 and 4.704 seconds**, in start-time order.
Their median is **17.070 seconds**; five samples do not establish a stable P95.
Homepage RSC median is 4.438 seconds (n=9), maximum 7.889 seconds.

The earlier [initial report](../after-1395-initial/report.md) contains two
serial direct PR GET checks at 3.343–5.124 seconds. Those requests use a
different navigation mode and workload. They establish that some requests
became much faster, not that subsequent navigation is consistently fast.

| PR request start CST | Time before `pr.board` starts | `pr.board` duration | Request duration |
|---|---:|---:|---:|
| [17:52:27](http://harbor:16686/trace/077e104be08982f38036bf33ef135b62) | 13.559 s | 13.433 s | 27.013 s |
| [17:53:22](http://harbor:16686/trace/5000c4c19910c363bfe3baeda913cafb) | 5.224 s | 3.547 s | 8.783 s |
| [17:53:31](http://harbor:16686/trace/1b53b65c46b2b90381f42835b15d070c) | 1.976 s | 2.709 s | 4.704 s |

These are server timings, not browser click-to-paint measurements. They show
two serial stages consistent with the reported experience, but do not prove
the exact moments the browser displays each part. The observed route is the
PR list `/pr/[project]`, not a numbered PR detail route. Requests overlap in
part of the window; browser identity and active concurrency are unknown.

## Remaining work on the request path

1. **The page blocks its content on header reads.** In
   `apps/board/src/app/pr/[project]/page.tsx:69–:99`, registered projects and
   on-board projects are awaited, followed by JSX prop awaits for locks and
   view counts. Only then can the returned Suspense subtree start the board
   reader. In the 27-second witness, `locks.read` alone lasts 6.302 seconds;
   the board reader starts 13.559 seconds into the request. In the next slow
   request, locks take 7.271 seconds and the board starts at 14.635 seconds.
2. **Each navigation reads the five PR streams three times.** The header's
   `placeViewsOf` calls `waitingPrs` → `openPr` → `listPrs`; the body calls
   `readProjectPrs`, then `readDraftOf` → `readDraftTickets` → `readDraft` →
   `listPrs`. Each of the five PR RSC requests has 15 PR event-stream reads.
   See `apps/board/src/lib/prs.ts:86–:98`, `:134–:135`, `:200–:217` and
   `packages/project/src/pr.ts:87–:106`, `:152–:153`.
3. **The remaining 21 draft ticket-title reads run serially.** The loop in
   `packages/project/src/pr.ts:620–:630` awaits each ticket stream. In the
   27-second witness, these reads occupy approximately request seconds
   21.192–26.083. #1395 correctly limits them to draft tickets; it has not
   removed their sequential round trips.

Each of these PR requests has 59 `events.read` spans: 21 ticket, 16 project,
15 PR, six account and one control stream. There are no GitHub request spans.
In the 27-second witness, the two observed projection-pool acquisitions take
0.002 and 0.273 seconds. That does not measure the event-store connection
pool: `events.read` still combines connection wait, query and decoding, so
the low-level cause of slower individual reads is not established here.

The next useful changes are to let the frame and independent content start
without the full header await chain; reuse one PR-state read within the
render for badge, cards and draft; and batch or use bounded concurrency for
draft titles. Recheck the same navigation mode after those changes, retaining
error behavior and coherent per-render data. No fix or new load test was
performed in this analysis.

## Archive

[requests.csv](requests.csv) and [summary.json](summary.json) retain all 16
request observations. [provenance.json](provenance.json) records the source
hash, window and limitations. [witness-spans.json.gz](witness-spans.json.gz)
retains 219 sanitized spans from the three tabled witnesses, including source
parentage. [checksums.json](checksums.json) records archive hashes.

All five PR requests still read only 21 draft ticket streams, compared with
roughly 800 historical tickets before #1395. This is structural improvement;
it does not make the remaining 17–27-second navigations acceptable. Draft
size, concurrency, background activity and cold/warm state differ from the
before cohort. Telemetry still carries no runtime commit attribute; deployment
evidence is retained in [the cutover record](../deployment-1395.json).

## Development-mode qualification

The live page process was confirmed as `next dev --turbopack`, launched through
`node ./serve.ts dev`, on port 17820. These observations are development-mode
measurements. Before attributing all remaining latency to application reads,
repeat the same PR navigation using a freshly built production board. The
serialized reads above are measured, but the development-mode contribution
to their absolute durations has not been isolated. Record the new process
start, build revision and production sample in a separate cohort.
