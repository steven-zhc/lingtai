/**
 * **The core must not branch on a locator's shape** —
 * [0066](../../../doc/decisions-archive/0066-a-large-answer-is-a-locator-on-the-log.md)
 * §4, measured (`#303`).
 *
 * §4 says the locator is a string the core never parses, and until this file
 * nothing checked it. `file:` is the only destination, its locator is a
 * repository path, and so **every path-shaped assumption in the pipeline is
 * accidentally correct**: `join`, `resolve`, a `startsWith("doc/")`, a stat —
 * each would work today and each would close the extension point, with no test
 * going red. The fixture is `test/a-url-destination.ts`; the claim is that a
 * string the core did not write survives the pass untouched.
 *
 * ## 0066 §9's own test is retired here, and why it must not be reinstated
 *
 * §9 says: *the test of whether §4 held is the **second** destination. If adding
 * it needs a change in `packages/conductor`, the locator did not stay a string.*
 *
 * **No destination can meet that, and none ever could.** Both that landed needed
 * `conduct.ts`:
 *
 * ```
 * file:       at design      #300, 819941c   +90
 * file-brief: at implement   #301, fa06a7a   +39
 * ```
 *
 * And the 39 are not a parser, they are a **port**:
 *
 * ```ts
 * const read = async (spec: { readonly path: string }): Promise<ReadAnswer> => {
 *   try { return { document: await readFile(join(cwd, spec.path), "utf8") }; }
 *   catch (error) { return { notRead: (error as Error).message }; }
 * };
 * …
 * fileBrief: { read },
 * ```
 *
 * `file:` got `keep`; `file-brief:` got `read`; a `confluence:` would get a
 * `fetch`. **Every plugin that touches the world outside the pass needs one port
 * from the conductor, and a port is additive rather than a parser** — so the
 * diff size was never a proxy for the property §4 protects, and a *real* second
 * destination measures it worse than this fixture does, because the port's lines
 * drown the signal.
 *
 * **The one line that comes closest is worth naming**, so the next reader does
 * not have to find it: `readFile(join(cwd, spec.path))` — the conductor does know
 * `file-brief`'s locator is a path. That is inside a port named for one plugin,
 * handed that plugin's own spec, so it is not the core learning to classify. A
 * test that asserted *no `join` anywhere near a locator* would be wrong. The
 * assertion has to be about **a locator the core did not write**.
 *
 * ## The port is the hole a pass-level test cannot see, so it is held on its own
 *
 * `carry` replaces `actionsAt` and all ten bodies, which is what makes it a unit
 * test — and it is also what puts the port layer **outside its module graph
 * entirely**. `test/a-url-destination.ts` imports `../src/pass.ts` and never
 * `conduct.ts`, so the four `it`s that run a pass are green against any port at
 * all, including one taught to classify. That is not a small gap: `conduct.ts`
 * is the file §9's retired criterion actually measured, and retiring it on the
 * strength of a check that cannot reach it would have left §4 recorded as
 * measured while the one place it can erode went unwatched.
 *
 * So the port is now a value rather than a closure — `readWhatAFileKept` in
 * `src/file-port.ts`, the same six lines with the filesystem handed in — and
 * *hands the locator to the filesystem unclassified* below calls it directly.
 * It is the one `it` here allowed to name a resolution, because naming it is
 * the assertion: `join(cwd, locator)` and that alone, asked for every string,
 * with nothing between the argument and the read. A port that returned early on
 * a `://`, or that read `new URL(locator).pathname` instead, fails it — and
 * both are what a reader generalising `fileBrief: { read }` into one
 * destination-agnostic port writes first.
 *
 * **And extracting a port moves that erosion path unless the call site is
 * pinned too**, which is the seventh `it`. A test that holds
 * `readWhatAFileKept` says nothing about `conduct.ts` still building
 * `fileBrief: { read }` out of it, so the same classifying branch written *at
 * the call site* leaves all six above green and `readWhatAFileKept` a function
 * only this file imports. So the wiring is read off `conduct.ts`'s own source —
 * `unit/one-store.test.ts`'s method, and here the only one there is: that file
 * reaches `node:fs/promises` directly, so there is no seam to hand a fake
 * through and nothing short of a whole pass to watch the real read go past.
 *
 * So §9's criterion is retired and this file replaces it. §4 stands unchanged
 * and is what these tests guard; there is no superseding ADR, because a check
 * that measures the wrong thing is a correction to a test rather than to a
 * decision. 0066 §9 carries a note saying so, beside the sentence it corrects —
 * `#299`'s arrangement, and for its reason: a correction that lives only in a
 * second file gets reinstated from the first.
 *
 * ## Broken three times on purpose, and what each break cost
 *
 * A test that guards a negative is worth what it catches, so the core was made
 * to do each forbidden thing once and the result recorded here rather than
 * remembered:
 *
 * ```
 * resolve      runStep's context: join(reaching.context.cwd, d.locator)   3 of 7 red
 * classify     designFrom: drop a locator containing "://"                3 of 7 red
 * canonicalise designFrom: new URL(locator).toString(), throw → as-is     3 of 7 red
 * port         file-port.ts: notRead on a "://", URL(…).pathname on the   1 of 7 red
 *              rest — the shared classifying port a second destination
 *              tempts somebody into writing
 * call site    conduct.ts: that same classifying port written inline      1 of 7 red
 *              where `read` is wired, and again as a wrapper around
 *              `readWhatAFileKept` — what extracting the port tempts
 *              somebody into instead
 * ```
 *
 * **Only the classify branch of the fourth is a change**, which is worth
 * recording because it looks like two: `join(cwd, new URL(`file:///${p}`).pathname)`
 * is byte-identical to `join(cwd, p)` on this locator — `path.join` already
 * collapses the doubled slash and resolves the `..`, so the parse buys the
 * rewriter nothing. The rewrites that *do* move the string are caught by the
 * same assertion: `new URL(p).toString()` lower-cases the host and
 * `decodeURIComponent(p)` eats the `%20`, and neither equals `join(cwd, p)`.
 *
 * The resolve left `/nowhere/https:/Example.INVALID/design/1%20a/` at both ends
 * — the doubled slash collapsed and so did the `..`, which is exactly the quiet
 * corruption a path-shaped core does to a URL — the classify left the locator
 * off the ending altogether, and the canonicalise left
 * `https://example.invalid/design/1%20a/`: a host lower-cased and a `..`
 * resolved, with nothing else about the pass changed. All three were reverted;
 * none is in the tree.
 *
 * **The third is the one the first version of this file could not catch**, and
 * it is why `A_URL` is deliberately not in canonical form. A validating core
 * reaches for `new URL` before it reaches for `join`, and against
 * `https://example.invalid/design/1` that round trip returns the string it was
 * given — so all four `it`s stayed green and the guard said nothing. The fifth
 * `it` now pins the literal itself.
 *
 * **The fourth is the one no version of this file could catch while the port
 * was a closure**, which is the section above: every `it` that runs a pass
 * stayed green against it, because none of them loads the module it is in. The
 * sixth `it` is the only thing that sees it, and it is the only thing that
 * needs to.
 *
 * **The fifth is what extracting the port made possible**, and the sixth cannot
 * see it either: `readWhatAFileKept` left in the tree behaving perfectly, and
 * the branch written where it is wired instead. Both forms were tried — the
 * whole port inlined at `read`, and a wrapper that classified first and
 * delegated to the value second — and each turns the seventh `it` and only it.
 * Neither is in the tree.
 *
 * *reaches no event* stayed green through all three of the first, and should:
 * it is a claim about what the core writes to the log, not about what it does
 * with the string in memory. Seven `it`s: three claims about the pass, the
 * board's, two about the port under it — what it does with a locator, and that
 * `conduct.ts` wires that value and no other — and one about the literal the
 * others are asked with.
 *
 * ## What is not checked here, and where it goes instead
 *
 * Credentials refused when the recipe resolves, and a real network failure —
 * 0066 §5's *unreachable* versus *needs a person*, which is left to measurement.
 * Both need a real cloud destination and belong to the first one somebody
 * actually wants. Building one to be tested would buy a page under
 * `doc/plugins/`, a `step-matrix` column and a `whyThatPair` branch forever, paid
 * for a probe — which is the bill 0066 §9 itemises.
 *
 * Unit by 0060 §1: no process, no network, no clock, and the one file opened is
 * this repository's own source — the subject rather than a dependency outside
 * the system, which is why `unit/one-store.test.ts` sits in this half doing the
 * same thing for the same kind of rule.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { TheDesign } from '@lingtai/actions'
import { describe, expect, it } from 'vitest'

import { readWhatAFileKept } from '../src/file-port.ts'
import { A_PATH, A_URL, DOCUMENT, NOWHERE, carry, withoutTheLocator, type Carried } from '../test/a-url-destination.ts'

/** Both ends of one pass, which is what every assertion below reads. */
const ends = (carried: Carried): readonly (TheDesign | undefined)[] => [
  carried.endedWith,
  carried.briefed,
  carried.handedBack,
]

/**
 * `conduct.ts` as written, with its prose stripped and its wrapping flattened.
 *
 * `unit/one-store.test.ts`'s `code`, and its precedent: a rule about what a
 * source may contain is asserted by reading the source, and that file is in the
 * unit half for the reason the header gives.
 */
const conductAsWritten = (): string =>
  readFileSync(fileURLToPath(new URL('../src/conduct.ts', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')

describe('a locator the core did not write', () => {
  /**
   * **The literal has to be one a parse would change**, or every `it` below
   * passes against a core that parses.
   *
   * This is the assertion about the fixture rather than about the pass, and it
   * is first because the other four are worth only what it is worth. `A_URL`
   * began as `https://example.invalid/design/1` — canonical, so
   * `new URL(locator).toString()`, the cheapest thing a core acquires on the way
   * to validating a locator, was a round trip that changed nothing and left
   * three of those four green. The literal now carries one thing per way of
   * parsing:
   *
   * ```
   * Example.INVALID   lower-casing a host        URL, and every HTTP client
   * /v2/..            normalising a `..`         URL, and path.join / resolve
   * %20               decoding a percent-escape  decodeURIComponent
   * trailing /        trimming a trailing slash  the usual "tidy it" helper
   * ```
   *
   * So a core that grew *any* of the four is caught by `toBe` — and this `it`
   * is what stops the literal being tidied back into canonical form by somebody
   * who reads it as a typo. It parses a string and asserts about the result,
   * which is the one place in this file that is allowed to: the claim is about
   * what a parse would do, and the only way to state it is to do one.
   */
  it('is a string no round trip through `URL` leaves alone', () => {
    const parsed = new URL(A_URL)

    expect(parsed.toString()).not.toBe(A_URL)
    expect(A_URL).toContain('Example.INVALID')
    expect(parsed.host).toBe('example.invalid')
    expect(A_URL).toContain('/v2/..')
    expect(parsed.pathname).toBe('/design/1%20a/')
    expect(A_URL).toContain('%20')
    expect(decodeURIComponent(A_URL)).not.toBe(A_URL)
    expect(A_URL.endsWith('/')).toBe(true)
  })

  /**
   * **Byte for byte, at both ends** — the near one is `StepPassed.design` off
   * the `design` visit, and the far one is `ActionContext.design` as the plugin
   * at `implement` was handed it.
   *
   * `toBe` on a string *is* byte equality: it fails on a trimmed slash, a
   * lower-cased host, a normalised `..`, a percent-decoded space. Every one of
   * those is something a core that had learned what a locator is would do, and
   * every one of them is a locator the reading plugin can no longer resolve.
   *
   * **All four are observable only because the literal carries one of each**,
   * which is the `it` above and not an accident of this one: byte equality
   * against a locator already in canonical form catches a core that resolves it
   * and misses a core that merely parses and re-serialises it.
   *
   * The third end is the return leg: `file-brief:` answers with the locator it
   * was handed, unchanged, so the value reaches `implement`'s own ending too and
   * a core that edited it on the way back would be caught there rather than
   * nowhere.
   */
  it('reaches both ends of the pass as the destination wrote it', async () => {
    const carried = await carry(A_URL)

    expect(carried.endedWith).toEqual({ document: DOCUMENT, locator: A_URL })
    expect(carried.briefed).toEqual({ document: DOCUMENT, locator: A_URL })
    for (const end of ends(carried)) expect(end?.locator).toBe(A_URL)
    expect(carried.outcome).toBe('landed')
  })

  /**
   * **The whole claim, as one `toEqual`.**
   *
   * The same pass twice — once carrying a URL, once carrying `file:`'s own
   * repository path — with every occurrence of the locator blanked to one token.
   * What is left is the shape of the pass: which steps ran, how each ended, what
   * each action answered, what reached the log. **They must be identical.**
   *
   * A core that branched on the shape differs here however it branched: a
   * `join(cwd, …)` leaves `/nowhere/https:/Example.INVALID/design/1%20a/` in the URL
   * arm and `/nowhere/doc/design/x.md` in the other, so the token no longer
   * matches and the two blanked routes disagree. A core that dropped a locator
   * it did not recognise leaves `endedWith` with no `locator` key on one arm
   * only. A core that threw on one leaves a different ending. None of them
   * survives this line, and none of them needs its own test.
   *
   * This is the assertion that makes the file worth keeping: it goes red the day
   * anything **on the pass's own path** learns to parse, whatever it learned —
   * `runPass`, `runActionPipeline`, `designOn`, `designFrom`, `runStep`'s
   * context. **It says nothing about the ports**, which `carry` does not load:
   * those are the last `it`'s, and the header says why they needed their own.
   */
  it('takes the same route through the pass that a repository path takes', async () => {
    const [url, path] = await Promise.all([carry(A_URL), carry(A_PATH)])

    expect(withoutTheLocator(url)).toEqual(withoutTheLocator(path))
  })

  /**
   * **Nothing resolved it against the worktree**, which is the failure the
   * pipeline is closest to having: the conductor genuinely does
   * `readFile(join(cwd, spec.path))`, legally, inside a port named for one
   * plugin and handed that plugin's own spec.
   *
   * Asked by running the same locator under two different `cwd`s. A core that
   * joined would answer differently at each; a core that treats the string as
   * opaque answers identically. That is a sharper question than *does `join`
   * appear anywhere*, and it is the one 0066 §4 actually asks.
   *
   * It is also what says nothing stat'd it. `A_URL` is not a path that exists
   * under either `cwd` — nor is anything it normalises to — so a core that stat'd it would
   * throw or report a failure, and the pass would not land.
   */
  it('does not resolve it against the worktree, wherever the worktree is', async () => {
    const elsewhere = '/somewhere/else/entirely'
    const [here, there] = await Promise.all([carry(A_URL, NOWHERE), carry(A_URL, elsewhere)])

    for (const end of [...ends(here), ...ends(there)]) {
      expect(end?.locator).toBe(A_URL)
      expect(end?.locator).not.toContain(NOWHERE)
      expect(end?.locator).not.toContain(elsewhere)
    }
    expect(withoutTheLocator(here)).toEqual(withoutTheLocator(there))
    expect(here.outcome).toBe('landed')
  })

  /**
   * **And the core wrote it nowhere a replay pays for** (0066 §3, 0069 §6).
   *
   * `WroteTheDesign` is the visit's ending, held in memory; what reaches the log
   * is `evidence`. So the board — `task_view`, a fold over these events — never
   * sees a locator at all, and cannot have parsed one.
   *
   * The fixture's `evidence` names no locator, which is the one place it differs
   * from `file:` on purpose: the real plugin's card says *wrote a 2.4 kB design
   * to `doc/design/x.md`*, because a person reads the card for the location.
   * With the plugin's own sentence carrying none, a locator found in an emitted
   * payload can only have been put there by the core.
   */
  it('reaches no event, so nothing the board folds has parsed it', async () => {
    const carried = await carry(A_URL)

    expect(carried.events.length).toBeGreaterThan(0)
    for (const event of carried.events) expect(event.payload).not.toContain(A_URL)
  })

  /**
   * **And the port under all of that did not look either** — the one thing the
   * four `it`s above cannot see, because `carry` replaces `actionsAt` and all
   * ten bodies and so never loads the module the port is in.
   *
   * `readWhatAFileKept` is `conduct.ts`'s `fileBrief: { read }`, which is the
   * core's only contact with a locator and therefore the only place §4 can
   * actually erode. Two things are asked of it, and a shared classifying port
   * fails one or the other however it is written:
   *
   * - **it asked**, once per locator and in order. A port that returns early on
   *   a string it recognised — `if (spec.path.includes("://")) return { notRead }`,
   *   the first line somebody generalising this into a destination-agnostic
   *   port writes — never reaches the filesystem at all, and `asked` is short.
   * - **it asked for `join(cwd, locator)`**, which is `file:` resolving `file:`'s
   *   own locator and is all it is entitled to. A port that read
   *   `new URL(locator).pathname` first asked for something else, and this is
   *   the one assertion in the file that names a resolution — naming it is the
   *   point, because *which* one is legal is exactly what is being pinned.
   *
   * The `A_PATH` arm is not decoration: it is what makes *unconditionally* a
   * claim rather than a hope. One string of each shape, one rule, one call each.
   *
   * The failure branch is asked the same question. A `notRead` this port
   * composed itself would be the port having recognised something before it
   * tried; what comes back is the filesystem's own sentence, and it is the same
   * sentence for both shapes.
   *
   * Unit for the file's reason: the filesystem is the argument, and no `readFile`
   * is anywhere near this.
   */
  it('hands the locator to the filesystem unclassified, whatever it looks like', async () => {
    const asked: string[] = []
    const read = readWhatAFileKept(NOWHERE, {
      read: async (at) => {
        asked.push(at)
        return DOCUMENT
      },
    })

    for (const locator of [A_URL, A_PATH]) {
      expect(await read({ path: locator })).toEqual({ document: DOCUMENT })
    }
    expect(asked).toEqual([join(NOWHERE, A_URL), join(NOWHERE, A_PATH)])

    const refused: string[] = []
    const broken = readWhatAFileKept(NOWHERE, {
      read: async (at) => {
        refused.push(at)
        throw new Error(`ENOENT: no such file or directory, open '${at}'`)
      },
    })

    for (const locator of [A_URL, A_PATH]) {
      expect(await broken({ path: locator })).toEqual({
        notRead: `ENOENT: no such file or directory, open '${join(NOWHERE, locator)}'`,
      })
    }
    expect(refused).toEqual([join(NOWHERE, A_URL), join(NOWHERE, A_PATH)])
  })

  /**
   * **And the port the `it` above holds is the one `conduct.ts` runs.**
   *
   * That is the half a test of the extracted value cannot supply, and without
   * it lifting the port out of `conduct.ts` moves the erosion path rather than
   * closing it. `readWhatAFileKept` is §4's guard only while
   * `fileBrief: { read }` is built out of it; the next person wiring a second
   * destination writes the classifying branch **at the call site** —
   * `if (spec.path.includes("://")) return { notRead }` above a
   * `readFile(join(cwd, new URL(`file:///${spec.path}`).pathname))` — and
   * `readWhatAFileKept` becomes a function only this file imports. Every `it`
   * above stays green against that, including the sixth: none of them loads
   * `conduct.ts` either.
   *
   * So the wiring is read off the file, which is `unit/one-store.test.ts`'s
   * method and here the only one there is: `conduct.ts` reaches the filesystem
   * through `node:fs/promises` directly, so there is no seam a unit test could
   * hand a fake through, and running a whole pass to watch a real `readFile` go
   * past would be integration by 0060 §1.
   *
   * Four things are asked of it, and the classifying call site above fails
   * three:
   *
   * - the import is there and `readWhatAFileKept` is **called once** — a call
   *   site that inlined the port calls it not at all;
   * - that call is **the whole of `read`**, byte for byte, so nothing sits
   *   between the port and the filesystem handed to it. A wrapper that
   *   classified first and delegated second is a different line;
   * - `fileBrief: { read }` is fed **that name**, so a second `read` declared
   *   beside the port and passed instead of it is not what `file-brief:` gets;
   * - and `readFile(` appears **once in the whole file**, inside that call — so
   *   `conduct.ts` reaches the filesystem for a locator nowhere else.
   *
   * It is a source-reading test and pays that price: a rename or a reformat of
   * that one line goes red and has to be answered rather than absorbed. That is
   * the cost of the guard, and the reader it stops is the one moving the
   * classification back in.
   */
  it('is the port `conduct.ts` wires, and the only read it wires', () => {
    const code = conductAsWritten()

    // The vacuity guard a source-reading test needs — `one-store.test.ts`'s: a
    // file that had moved, or a subject that had been renamed, would leave the
    // counts below true of nothing.
    expect(code).toContain('export function runOnce(')
    expect(code).toMatch(/import \{ readWhatAFileKept \} from ["']\.\/file-port\.ts["']/)

    expect(code).toMatch(/const read = readWhatAFileKept\(cwd, \{ read: \(at\) => readFile\(at, ["']utf8["']\) \}\)/)
    expect(code).toContain('fileBrief: { read },')
    expect(code.match(/readWhatAFileKept\(/g)).toHaveLength(1)
    expect(code.match(/readFile\(/g)).toHaveLength(1)
  })
})
