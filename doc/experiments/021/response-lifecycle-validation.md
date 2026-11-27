# Validating `node.response` (#1442)

What `node.response` is: one span per physical HTTP response, scope
`lingtai-board.response`, child of the request span (`BaseServer.handleRequest`).
Attributes: `lingtai.response.outcome` (`finished` | `closed-before-finish`) and
`lingtai.response.headers_sent`. `finished` means the server handed the last bytes
to its transport; it is not proof the browser received or painted the page.

This procedure changes nothing by itself: it does not restart or reconfigure a
service. A person does steps 1–3.

1. Record the build: `git rev-parse HEAD` of the running board (the daemon's
   `ConductorStarted` commit, or `lingtai doctor`). Write it at the top of the capture.
2. Enable `telemetry.otlp_endpoint` by hand in `~/.lingtai/config.yml`, and restart
   the board yourself. With no endpoint nothing is subscribed and no work is done.
3. Make two navigations to a measured page (home, a ticket, or a PR list/detail):
   - **complete**: click, wait until it has rendered;
   - **interrupted**: click, then click away or close the tab mid-load.
4. In Jaeger, open each trace and read, for its `BaseServer.handleRequest` root:
   - `lingtai.response.outcome` of its `node.response` child;
   - the end of `node.response` against the end of the request span;
   - whether any `node.response` is there at all.

| Observed | Reading |
|---|---|
| `closed-before-finish`, ends at or before the request span | an interrupted navigation |
| `finished`, ends after the request span | the request span ended while the response was still being delivered |
| no `node.response` under the request | **unknown** |

Record unknown intervals as unknown: do not assign them a cause. A completed
navigation with no `node.response` under a measured root means the async-context
binding failed in this build, which is itself the finding. The two things only a
real server shows are that the subscriber's context reaches Next's `handleRequest`
span, and that one physical request starts exactly one such span.

| Build | Navigation | Outcome | Response end vs request end | Notes |
|---|---|---|---|---|
| | complete | | | |
| | interrupted | | | |
