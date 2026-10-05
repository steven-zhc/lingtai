/**
 * **The `file:` destination's port into the filesystem**, lifted out of
 * `conduct.ts` so that a test can hold it
 * ([0066](../../../doc/decisions-archive/0066-a-large-answer-is-a-locator-on-the-log.md)
 * §4, `#303`).
 *
 * ## Why this is its own module
 *
 * 0066 §4 says the locator is a string the core never parses, and the port is
 * **the core's only contact with one**. `unit/a-locator-the-core-did-not-write.test.ts`
 * carries a URL locator through `runPass` and asserts it byte-for-byte at both
 * ends — but that test replaces `actionsAt` and all ten bodies, so the port
 * layer is outside its module graph entirely, and a port taught to classify a
 * locator by shape left the whole file green. That is the hole this module
 * closes: the port is now a value a unit test can call, hand a URL to, and ask
 * *what did you do with it*.
 *
 * It is `ports.ts`'s reason one level down, in that file's own words: *that
 * ordering is the reason this is a port and not a convenience — a fake can
 * assert it*. Nothing about the behaviour changed when it moved.
 *
 * ## What it is allowed to know, and what it is not
 *
 * It knows its locator is a path, and that is legal: it is named for one plugin
 * and is handed that plugin's own spec, so `join(cwd, spec.path)` is `file:`
 * resolving `file:`'s locator rather than the core deciding what kind of string
 * it was given. What it may not do is **look**. Every string it is handed goes
 * the same way — one resolution, applied unconditionally, with no branch
 * between the argument and the read — because the day it grows one, `file:` has
 * stopped being one destination among many and the extension point 0066 §4
 * bought is closed.
 *
 * A `confluence:` gets its own port with its own `fetch`, beside this one and
 * never inside it.
 */
import { join } from 'node:path'

import type { ReadAnswer } from '@lingtai/actions'

/**
 * The filesystem, as the one thing this port needs from its caller.
 *
 * `readFile(at, "utf8")` and nothing else is asked of it — a method on an
 * object rather than a bare function, so the shape matches `FileBriefActionDeps`
 * and a reader meets one convention.
 */
export interface WhatIsUnderTheWorktree {
  read(at: string): Promise<string>
}

/**
 * `implement` — the design back off the path a `file:` kept it at (0066 §4,
 * 0069 §4, `#301`).
 *
 * `keep`'s mirror, and the smaller half of the pair: no `git`, because a read
 * asks the worktree what is there rather than changing it, and the commit is
 * what the keep already answered for.
 *
 * Under `cwd` for the keep's reason, and it is the same `cwd`: the locator is a
 * path the `file:` at `design` wrote into this pass's own tree, and
 * `whyThePathEscapes` — the schema's own rule, asked again by the action — has
 * refused anything that is not one before this is called.
 *
 * **`notRead` and never a throw**, for the keep's reason: `implement` may not
 * refuse (0058 §3), and an exception out of a plugin is a step that did not
 * finish with no words on it. A file the destination said it wrote and that is
 * not there — an `ENOENT` — arrives here as the sentence a person reads, which
 * is the only thing that separates *the design was not kept* from *the design
 * was not read*.
 *
 * **And the sentence is the failure's own, on every string.** A `notRead` this
 * port composed itself would be the port having recognised something about the
 * locator before it tried it, which is the one thing it may not do; what a
 * caller gets is what the filesystem said about the place the locator resolved
 * to, whatever the locator looked like.
 */
export function readWhatAFileKept(
  cwd: string,
  underneath: WhatIsUnderTheWorktree,
): (spec: { readonly path: string }) => Promise<ReadAnswer> {
  return async (spec) => {
    try {
      return { document: await underneath.read(join(cwd, spec.path)) }
    } catch (error) {
      return { notRead: (error as Error).message }
    }
  }
}
