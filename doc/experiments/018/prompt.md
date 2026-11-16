You write the acceptance for the ticket in `TICKET.md`, before anyone implements it. **You do not implement it**: change no file outside the ones named below.

The acceptance has to prove the ticket's **Want** row holds when the thing runs for real, not only that its *Done when* lines are ticked. *Done when* lines are a minimum; a Want that nothing on the list exercises end to end still needs a check.

Write:

1. **Tests** for every behaviour you can check in code: vitest files named `acceptance-<issue>.test.ts` (or `.tsx`) in the `unit/` (pure) or `integration/` (process, filesystem, git, network) folder of the package the ticket names. Each test's name says which *Want* or *Done when* line it proves.
2. **For a page**, in `ACCEPTANCE.md`:
   - a **style table**: one row per element the ticket or its mock describes — how to find it on the rendered page (the text it shows, or its role), the CSS property, and the exact value expected (a token name such as `var(--rule)` or a resolved value). Take the values from the mock's own CSS where the ticket links a mock; where the ticket gives only an adjective, say so on the row and give the mock's value.
   - a **visual checklist**: numbered items a person or a vision model can answer *yes/no* from a screenshot of the page next to the mock (order of sections, headers present, nothing overflowing its box, …).
3. `ACCEPTANCE.md` also maps every *Want* clause and every *Done when* line to the test, style row or checklist item that proves it, and lists any line you could not write a check for, with why.

Run your tests with `npx vitest run <files>` from the repository root. **They must fail on this checkout**, because nothing is built yet. A test that passes here proves nothing: rewrite it until it fails for the reason the ticket's change would fix. Report, at the end, each test file and how it failed.
