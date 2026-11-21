/**
 * `applySetup`: the one writer of a new project's recipe, and the registration
 * that follows it (#968).
 *
 * **Written once.** The questions are answered against a draft of the file
 * (`draftRecipe`) that keeps every change made to it, in order, and never touches
 * the disk; the changes are what arrive here as `Answers`, and this is the only
 * place they reach `~/.lingtai/<project>/recipe.yml` — in one replace. A
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
import { type ChangeOptions, changeRecipe, draftRecipe, RecipeNotRecordedError, recipePath } from '@lingtai/project'
import { type RecipeChange, type Said } from '@lingtai/recipe'
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
}

export class SetupWriteError extends Error {
  readonly _tag = 'SetupWriteError'
}

/** The recipe is on disk and nothing registered it (the registration refused, or threw). */
export function keptSentence(path: string): string {
  return `the recipe at ${path} is kept and nothing was registered`
}

/**
 * The recipe text `applySetup` will leave on disk, computed without writing:
 * what a caller resolves (the base, the config hash) before it registers.
 */
export function previewSetup(target: ApplyTarget, answers: Answers): Effect.Effect<string, SetupWriteError> {
  return Effect.gen(function* () {
    const unresolved = (err: unknown) => new SetupWriteError(`the recipe would not resolve: ${(err as Error).message}`)
    const draft = yield* draftOver(target, answers).pipe(Effect.mapError(unresolved))
    yield* draft.set(answers.changes).pipe(Effect.mapError(unresolved))
    return draft.text() as string
  })
}

/** The draft of a project's recipe, over whatever `ProjectFiles` the caller provides (the disk by default). */
const draftOver = (target: ApplyTarget, answers: Answers) =>
  draftRecipe(answers.project, {
    home: target.home,
    ...(answers.said === undefined ? {} : { said: answers.said }),
  })

/** Where `applySetup` writes, and who it says wrote it: `by` is `human:<user>`, and `store` the log (the process's own when absent). */
export interface ApplyWriteTarget extends ApplyTarget {
  by: string
  store?: ChangeOptions['store']
}

/**
 * Write the recipe once — `changeRecipe`, the file and then the event naming `by` — then run `register`. Fails with
 * `SetupWriteError` before anything is written when the changes do not resolve; `register`'s own failure is
 * returned as it came, after the write — and the file stays. A recipe written and not recorded is reported and
 * `register` does not run: a rerun of `lingtai add` registers.
 */
export function applySetup<A, E>(
  target: ApplyWriteTarget,
  answers: Answers,
  register: Effect.Effect<A, E>,
): Effect.Effect<{ path: string; registered: A }, SetupWriteError | E> {
  return Effect.gen(function* () {
    const path = recipePath(answers.project, target.home)
    const changed = yield* changeRecipe(
      answers.project,
      { changes: answers.changes, ...(answers.said === undefined ? {} : { said: answers.said }) },
      {
        by: target.by,
        ...(target.store === undefined ? {} : { store: target.store }),
        ...(target.home === undefined ? {} : { home: target.home }),
      },
    ).pipe(
      Effect.mapError((err) =>
        err instanceof RecipeNotRecordedError
          ? new SetupWriteError(err.message)
          : new SetupWriteError(`${path} was not written: ${(err as Error).message}`),
      ),
    )
    // A refusal is passed up by name, never reported as written.
    if (!changed.ok) return yield* Effect.fail(new SetupWriteError(`${path} was not written: ${changed.message}`))
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
