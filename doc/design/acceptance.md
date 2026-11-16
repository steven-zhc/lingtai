# Acceptance: does what landed do what the ticket asked?

*A discussion draft, 2026-11-16. Nothing here is decided or built. It becomes an
ADR only after [experiment 018](../experiments/018-would-an-acceptance-agent-have-caught-it.md)
has measured it.*

## The gap

An attempt today answers two questions before it lands:

- **Is the code broken?** `build`: format, lint, typecheck, the unit half
  ([0060](../decisions-archive/0060-the-gate-runs-unit-tests.md)).
- **Does the code read right?** `review`: a cold reviewer on another runtime
  reads the diff against the ticket.

Nothing asks the third question: **does the result do what the ticket asked?**
Both checks look at the code; neither runs the requirement. Two tickets landed on
2026-11-16 show the shape of what passes:

- **#1196** built the task page's Sandbox tab. Every structural *Done when* held,
  build and review passed, and the page did not look like its agreed mock
  (#1237): every border in the dark `--muted`, headings at the default `h3`,
  paths overflowing their boxes. Nothing rendered the page.
- **#1193** added an acceptance case for the hook socket. It passed with the bug
  put back, because the test created the directory before `wrap` and srt
  resolved it. The case was run only on the fix, and green was taken as proof.

The first is *the requirement was never checked*; the second is *the check could
not fail*. Both are a property of who writes the check and when.

## The idea

Two rules, before any kind-specific machinery:

1. **The acceptance is written before the implementation, by someone other than
   the implementer, from the ticket alone.** An implementer's own test checks its
   own reading of the ticket. #1196's agent chose `--muted` and would have tested
   for `--muted`.
2. **An acceptance must be able to fail.** It runs on the base first and must be
   red there, then on the candidate and must be green. *Red on base, green on
   the candidate* is mechanical, and it is exactly what #1193's case lacked.

Then by kind:

| Kind | What is written before `implement` | What decides |
|---|---|---|
| `bug` | a test that reproduces the failure the ticket's Evidence shows | red on base and green on the candidate, both |
| `feature`, no UI | one check per *Done when* line, tests in the unit or integration project, scoped to the files they touch | every line has a check that passes; a short report says which check proves which line |
| `feature`, UI | (a) the computed styles of the named elements against the ticket's value table; (b) a screenshot of the page on fixed data, judged against the mock item by item | (a) all equal; (b) every checklist item *matches*, never a total score |
| `documentation` | render, links, images, code blocks | mechanical |

**Not a similarity percentage for UI.** A whole-image score is unstable (fonts,
data length, a wrapped line) and blind to what matters (#1196's dark borders are
a few pixels of a large page). The mock also carries sample data a real page
never has. So: exact where the ticket gives a value, and a per-item judgement
where it gives a picture.

## Where it would sit

Inside the ten steps, with no new step:

- **`design`**: an acceptance agent writes the checks from the ticket and commits
  them on the branch, before `implement` starts.
- **`build`**: runs them, after running them once on the base to prove they fail
  there.
- The implementing agent may not change the acceptance files. The tamper watch
  (#31) already knows how to hold a path; here it would hold these files only.

A failed acceptance is a refusal like a red build: it buys a fix round
([0108](../decisions/0108-a-refusal-buys-a-round.md)), and a person is the floor.

## What it costs, and what can go wrong

- **One more agent run per ticket.** Measured in 018, not guessed.
- **The acceptance agent can be wrong**: test the wrong thing, or ask for more
  than the ticket did. That is a refusal the implementer cannot fix, so the
  judge has to be able to send it back to the acceptance, not to the code.
- **UI needs a rendering harness**: the board on fixture data, a headless
  browser, inside the sandbox. That is real work and is only worth it if 018's
  UI cases are caught.
- **Integration time.** The integration half takes 803 s; an acceptance runs
  only the files it wrote.
- **A check that cannot fail.** Rule 2 is the defence; 018 measures how often an
  acceptance agent writes one anyway.

## Open questions

- Who writes UI acceptance when a ticket has no mock or value table? Refuse the
  ticket at `admit`, or skip the visual half?
- Does the acceptance agent see the design note from the `design` step, or only
  the ticket?
- A ticket that is pure refactoring (`tech-debt`, behaviour unchanged): is
  *the existing tests still pass* its whole acceptance?
- Can the acceptance agent be the cold reviewer's runtime, so the two checks
  share a blind spot less often with the implementer?

## Related

- [0060](../decisions-archive/0060-the-gate-runs-unit-tests.md): the build gate
  runs the unit half; the integration half runs after the merge.
- [0108](../decisions/0108-a-refusal-buys-a-round.md): a refusal buys a round,
  and a person is the floor.
- Experiment [015](../experiments/015-does-a-design-make-the-implementing-run-smaller.md)
  measured whether the `design` step pays for itself; 018 does the same for
  acceptance.
