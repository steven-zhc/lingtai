# 0.17.0: a landing that can be verified

Everything written while planning 0.17.0, in one place. The milestone on GitHub
is `0.17.0`. Nothing here is decided or ticketed yet.

## The goal

Today an attempt asks *is the code broken?* (`build`) and *does it read right?*
(`review`). Nothing asks *does the result do what the ticket asked?* 0.17.0 adds
that question, answered by checks written from the ticket before the code
exists and run before anything lands.

The operator's shape (2026-11-16):

- **At `design`, a second agent runs beside the design agent** and writes the
  acceptance from the ticket alone: for a page, a Playwright script that renders
  it and takes screenshots; for behaviour, integration tests that exercise the
  requirement.
- **At the end of the attempt, those checks decide** whether the feature was
  delivered.

## What already exists

| File | What it is |
|---|---|
| [../../design/acceptance.md](../../design/acceptance.md) | The discussion draft: written before `implement` by someone other than the implementer; red on base, green on the candidate; by kind; where it sits; what it costs; open questions |
| [../../experiments/018-would-an-acceptance-agent-have-caught-it.md](../../experiments/018-would-an-acceptance-agent-have-caught-it.md) | Measured on eight tickets that landed wrong: caught 5, missed 2, 1 not verified; cannot-fail 0 of 8; about $3 and 4–9 minutes a ticket |

018's findings that bear on the shape:

1. For a page, the defects were caught by a style table and a checklist judged
   on a screenshot, not by unit tests; a harness has to render the page on
   fixture data.
2. For behaviour, the agents wrote unit tests over fakes even when asked for
   end-to-end checks, and missed the two defects only a real run shows.
3. Run after the fact, most red tests were guessed interfaces; run before
   `implement` they are the interface handed to the implementer. Only a forward
   trial measures whether that misleads.

## To discuss before cutting

- **Parallel to the design agent, or after it?** In parallel the acceptance
  cannot see the design note (018 wrote from the ticket alone); after it, it
  costs wall time.
- **Where the checks run.** `build` (a refusal buys a fix round, 0108) or a new
  point before `merge`; and whether they also run on the base to prove they can
  fail.
- **Integration tests in an attempt.** The integration half takes 803 s and is
  out of every ticket's reach today; an acceptance would run only its own files.
- **The UI harness.** The board on fixture data and a headless browser inside
  the sandbox; screenshots judged item by item, never a similarity score.
- **A wrong acceptance.** The implementer cannot fix it; the judge must be able
  to send it back to the acceptance, not to the code.
- **The forward trial 018 asks for** (the next UI tickets, acceptance written at
  `design`, run by hand) before an ADR.
