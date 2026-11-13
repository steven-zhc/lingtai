/**
 * `applySetup`: the one writer of a new project's recipe, and the registration
 * that follows it (#968).
 *
 * **Written once.** The questions are answered against a draft of the file
 * (`draftFiles`) that keeps every change made to it, in order, and never touches
 * the disk; the changes are what arrive here as `Answers`, and this is the only
 * place they reach `~/.lingtai/<project>/recipe.yml` — in one `setRecipe` call. A
 * refusal while asking therefore leaves nothing behind, and a page that collects
 * the same changes can call the same writer.
 *
 * **Registration is a port, not an import.** Both registrations — `add()` for a
 * GitHub project and `addLocal` for a directory — live in `@lingtai/conductor`
 * (`onboard.ts`), which depends on this package; importing either would be a
 * cycle. The caller hands the registration in as an Effect.
 *
 * **A failure between the write and the registration leaves the recipe**, and
 * says so. "Registered" is the test `lingtai add` applies to a rerun, never "the
 * file exists", so the rerun is not refused: it asks again over the file that is
 * there.
 *
 * **Two adds at once** are not serialised (no new lock, #968). The second one's
 * registration is refused by whatever refuses it today, the expected-version
 * append in `onboard.ts`. The window between an add's check and its write is
 * accepted: the recipe either add wrote may stay.
 */
import type { ProjectState } from '@lingtai/domain'
import { diskFiles, type RecipeChange, type RecipeFiles, recipePath, type Said, setRecipeEffect } from '@lingtai/recipe'
import { Effect } from 'effect'

/** What the questions decided: every change they made to the recipe, in order. */
export interface Answers {
  project: string
  changes: readonly RecipeChange[]
  /** A comment above each block, used only when the file is created. */
  said?: Said
}

export interface ApplyTarget {
  home?: string
  files?: RecipeFiles
}

export class SetupWriteError extends Error {
  readonly _tag = 'SetupWriteError'
}

/** The recipe is on disk and nothing registered it (the registration refused, or threw). */
export function keptSentence(path: string): string {
  return `the recipe at ${path} is kept and nothing was registered`
}

/**
 * A `RecipeFiles` over a draft: reads fall through to `base` until the first
 * write, writes stay in memory, and every change set is kept for `applySetup`.
 */
export function draftFiles(base: RecipeFiles, path: string): RecipeFiles & { changes: () => RecipeChange[] } {
  let draft: string | undefined
  const recorded: RecipeChange[] = []
  return {
    read: (p) => (p === path && draft !== undefined ? Promise.resolve(draft) : base.read(p)),
    replace: (p, text) => {
      if (p !== path) return Promise.reject(new Error(`a draft of ${path} was asked to write ${p}`))
      draft = text
      return Promise.resolve()
    },
    recorded: (changes) => {
      recorded.push(...changes)
    },
    changes: () => [...recorded],
  }
}

/**
 * The recipe text `applySetup` will leave on disk, computed without writing:
 * what a caller resolves (the base, the config hash) before it registers.
 */
export function previewSetup(target: ApplyTarget, answers: Answers): Effect.Effect<string, SetupWriteError> {
  return Effect.gen(function* () {
    const path = recipePath(answers.project, target.home)
    const scratch = draftFiles(target.files ?? diskFiles, path)
    const unresolved = (err: unknown) => new SetupWriteError(`the recipe would not resolve: ${(err as Error).message}`)
    const existing = yield* Effect.tryPromise({ try: () => scratch.read(path), catch: unresolved })
    const written = yield* setRecipeEffect(answers.project, answers.changes, {
      home: target.home,
      files: scratch,
      ...(existing === null && answers.said !== undefined ? { said: answers.said } : {}),
    }).pipe(Effect.mapError(unresolved))
    return written.text
  })
}

/**
 * Write the recipe once, then run `register`. Fails with `SetupWriteError`
 * before anything is written when the changes do not resolve; `register`'s own
 * failure is returned as it came, after the write — and the file stays.
 */
export function applySetup<A, E>(
  target: ApplyTarget,
  answers: Answers,
  register: Effect.Effect<A, E>,
): Effect.Effect<{ path: string; registered: A }, SetupWriteError | E> {
  return Effect.gen(function* () {
    const files = target.files ?? diskFiles
    const path = recipePath(answers.project, target.home)
    const before = yield* Effect.tryPromise({
      try: () => files.read(path),
      catch: (err) => new SetupWriteError(`could not read ${path}: ${(err as Error).message}`),
    })
    yield* setRecipeEffect(answers.project, answers.changes, {
      home: target.home,
      files,
      ...(before === null && answers.said !== undefined ? { said: answers.said } : {}),
    }).pipe(Effect.mapError((err) => new SetupWriteError(`${path} was not written: ${(err as Error).message}`)))
    const registered = yield* register
    return { path, registered }
  })
}

/**
 * The stream `lingtai add` would collide with, matched on the name alone and
 * case-insensitively (a project is keyed by its name, whoever owns it) — the
 * same line `list-repositories.ts`'s `onboardedAs` draws for the board's
 * *already added*: a project with a stream is `registered`, `pending` or
 * `unrecorded`, and all three are refused.
 */
export function alreadyAdded(projects: readonly ProjectState[], name: string): ProjectState | undefined {
  return projects.find((p) => p.project !== null && p.project.toLowerCase() === name.toLowerCase())
}

/** What `lingtai add` says of a project that is already added: where it is edited. */
export function alreadyAddedSentence(name: string, home?: string): string {
  return `${name} is already added — its recipe is ${recipePath(name, home)}, and it is edited there`
}
