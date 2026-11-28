/**
 * The runner a setup list walks (0125 §9, #1527): one `runSetupList`, generic over the context `C`
 * every question receives. The machine's list (`machine-list.ts`) and the project's run on it; each
 * supplies descriptors and a terminal or a board supplies an `Asker` per question id.
 *
 * **A descriptor decides; an asker only asks.** The runner reads what is in force, decides the
 * default, gets an answer — a flag, the default where there is no terminal or `--defaults`, a fixed
 * or derived answer, or the asker — and writes it. The runner writes nothing to `ctx` itself: what a
 * later question reads from an earlier answer, the earlier question's `write` put there.
 */
import { Effect } from 'effect'

/** What is in force for one question: the value and whose it is, a fault in it, or nothing. */
export type InForce =
  | { value: string; from: 'environment' | 'file'; variable?: string }
  | {
      /** What is wrong with it, said before asking. */
      fault: string
      from: 'environment' | 'file'
      variable?: string
      /** The answer that keeps what is there, where the fault is not the value's own (a database that is down). */
      value?: string
      /** A fault the run cannot repair (an exported variable): refused by name rather than asked. */
      fatal?: boolean
    }
  | null

export interface WriteResult {
  wrote: boolean
  /** The answer needs a step this list does not run (an App that does not exist yet); nothing was written. */
  pending?: true
}

/** The runner's view of the defaults, handed to `systemDefault`: `defaults` includes a switch already answered yes. */
export interface DefaultsMode {
  defaults: boolean
  interactive: boolean
}

export interface SetupRow {
  id: string
  label: string
  text: string
  group: 'machine' | 'project' | 'attempt'
  changed: boolean
}

/** Pure projection of settled state; composite rows own all their components. */
export interface Presentation<C> {
  label: string
  group: SetupRow['group']
  order?: number
  before: (ctx: C) => unknown
  value: (ctx: C) => unknown
  format: (value: unknown, ctx: C) => string
  diff?: (before: unknown, value: unknown, ctx: C) => string
}

export function setupRows<C>(list: readonly SetupQuestion<C>[], ctx: C): SetupRow[] {
  return list
    .filter((q) => q.presentation !== undefined)
    .sort((a, b) => (a.presentation!.order ?? list.indexOf(a)) - (b.presentation!.order ?? list.indexOf(b)))
    .map((q) => {
      const p = q.presentation!
      const before = p.before(ctx)
      const value = p.value(ctx)
      const changed = before !== undefined && JSON.stringify(before) !== JSON.stringify(value)
      return {
        id: q.id,
        label: p.label,
        group: p.group,
        changed,
        text: changed
          ? (p.diff?.(before, value, ctx) ?? `${p.format(before, ctx)} → ${p.format(value, ctx)}`)
          : p.format(value, ctx),
      }
    })
}

export interface SetupQuestion<C> {
  id: string
  presentation?: Presentation<C>
  /** The answer row for a machine descriptor; values always pass through its safe formatter. */
  card?: { label: string; environment: string }
  /** The subject of a refusal — "the daily spend ceiling". */
  name: string
  /** The text after "pass" in a refusal. */
  flag: string
  /** The answer a flag names, null where none does (or absent); a refusal where the flag is not one this question takes. */
  fromFlags?: (flags: Readonly<Record<string, string>>, ctx: C) => string | null | { refused: string }
  /** What a flag value is compared with what is in force as, and what is written. */
  normalize?: (answer: string) => string
  /** Absent: nothing is in force (a confirmation or a switch has none). */
  inForce?: (ctx: C) => Effect.Effect<InForce, unknown>
  /**
   * The default where nothing is in force; absent or null where the question has none (0121 §9). Not read where a
   * flag answers. `{ refused }` is a default that could not be read: the runner returns it where that default would
   * have been the answer — no flag, nothing in force, and either no terminal to ask on or `--defaults` — and
   * otherwise (a terminal, no `--defaults`) the question is asked with no default drawn.
   */
  systemDefault?: (ctx: C, mode: DefaultsMode) => Effect.Effect<string | null | { refused: string }, unknown>
  /** The answer that is equal to what is in force, where that is not its value (a token that is set is `keep`). */
  answerOf?: (inForce: NonNullable<InForce>) => string | null
  /** Whether a flag answer is the one an exported value already is, where that is not its text. */
  sameAsEnvironment?: (answer: string, value: string) => boolean
  /** A refusal of an exported value this command cannot use, or null. */
  refusesEnvironment?: (value: string) => string | null
  /** Null accepts; a string is why not. Absent accepts. */
  validate?: (answer: string, ctx: C) => Effect.Effect<string | null, unknown>
  /** Whether this run is to ask it now; no puts it in `deferred`, with no entry. */
  needed?: (ctx: C) => Effect.Effect<boolean, unknown>
  /** False: not part of this run — neither asked nor refused; the entry says so. Pure. */
  applies?: (ctx: C) => boolean
  /** An answer this run fixes, or a refusal of the flag that contradicts it; null where nothing is fixed. Pure. */
  fixed?: (ctx: C, flag: string | null) => { answer: string } | { refused: string } | null
  /** An entry with no question: the answer is derived from `ctx`. Pure. */
  derive?: (ctx: C) => string
  /**
   * A confirmation: the `--defaults` flag answers yes, no terminal is refused, and `no` is refused with `declined` —
   * a function where the sentence names what the walk has answered so far. Defaults a yes to the switch turned on
   * do not answer it: a confirmation after the switch is still asked.
   */
  confirm?: { declined: string | ((ctx: C) => string) }
  /** A defaults switch. Project preview orchestration consumes it before the configuration walk. */
  defaultsSwitch?: true
  write: (answer: string, inForce: InForce, ctx: C) => Effect.Effect<WriteResult | { refused: string }, unknown>
  /** The card row: the value, and what it was. */
  row: (value: string, before: InForce, description?: string) => string
  /** Words for `why`, drawn where the question is asked. */
  why?: readonly string[]
  /** What the environment's value is shown as. */
  show?: (value: string) => string
}

/** What an asker sees of a question: `ctx` already applied, so nothing here takes it. */
export interface AskedQuestion {
  id: string
  name: string
  flag: string
  why?: readonly string[]
  show?: (value: string) => string
  validate: (answer: string) => Effect.Effect<string | null, unknown>
}

/** What an asker is handed: the question, the default already decided, and what is kept if it is abandoned. */
export interface Decided<C = unknown> {
  question: AskedQuestion
  ctx: C
  default: string | null
  inForce: InForce
  kept: string
  startOver?: string
  why: readonly string[]
}

export type AskerAnswer = { answer: string } | { refused: string }
export type Asker<C = unknown> = (decided: Decided<C>) => Effect.Effect<AskerAnswer, unknown>

export interface SetupInput<C = unknown> {
  /** False where there is no terminal. Never inferred from an asker answering nothing. */
  interactive: boolean
  /** `--defaults`. */
  defaults: boolean
  flags: Readonly<Record<string, string>>
  askers: Readonly<Record<string, Asker<C>>>
  /** Said by the runner: a fault in what is in force, before it asks again. */
  log: (line: string) => void
  /** What is still true if the next question is abandoned, given what this run has written. */
  kept?: (written: readonly Entry[]) => { kept: string; startOver?: string }
}

export interface Entry {
  id: string
  before: InForce
  /** The answer, or null where an environment value decided, nothing was asked, or the entry did not apply. */
  after: string | null
  wrote: boolean
  pending: boolean
  asked: boolean
  /** False only where the question's `applies` said no. */
  applies: boolean
}

export type ListResult<C> =
  | { refused: string; entries: Entry[]; failedId?: string; deferred: SetupQuestion<C>[] }
  | { refused?: undefined; entries: Entry[]; failedId?: string; deferred: SetupQuestion<C>[] }

const normalized = <C>(q: SetupQuestion<C>, answer: string): string =>
  q.normalize === undefined ? answer : q.normalize(answer)

const defaultKept = (written: readonly Entry[]): { kept: string; startOver?: string } => ({
  kept:
    written.filter((e) => e.wrote).length === 0
      ? 'Nothing was written'
      : `what was answered above is kept (${written
          .filter((e) => e.wrote)
          .map((e) => e.id)
          .join(', ')})`,
})

/**
 * Walks `list` in order. A question whose `needed` says no is not asked and not skipped: it is returned in
 * `deferred`, for a later run. A refusal stops the walk; what was already written stays, and `entries` says so.
 * Where `C` has a required field the context is required; where every field is optional it may be left out.
 */
export function runSetupList<C extends object>(
  list: readonly SetupQuestion<C>[],
  input: SetupInput<NoInfer<C>>,
  ...[given]: {} extends C ? [ctx?: C] : [ctx: C]
): Effect.Effect<ListResult<C>, unknown> {
  const ctx = (given ?? {}) as C
  return Effect.gen(function* () {
    const entries: Entry[] = []
    const deferred: SetupQuestion<C>[] = []
    let failedId: string | undefined
    const refuse = (refused: string): ListResult<C> => ({ refused, entries, deferred, failedId })
    let defaults = input.defaults

    for (const q of list) {
      failedId = q.id
      if (q.needed !== undefined && !(yield* q.needed(ctx))) {
        deferred.push(q)
        continue
      }
      const flag = q.fromFlags?.(input.flags, ctx) ?? null
      if (flag !== null && typeof flag === 'object') return refuse(flag.refused)

      if (q.applies !== undefined && !q.applies(ctx)) {
        entries.push({
          id: q.id,
          before: null,
          after: null,
          wrote: false,
          pending: false,
          asked: false,
          applies: false,
        })
        continue
      }

      const validateAnswer = (answer: string): Effect.Effect<string | null, unknown> =>
        q.validate === undefined ? Effect.succeed(null) : q.validate(answer, ctx)

      // An answer the runner does not ask for: derived, or fixed by the run.
      let settled: string | null = null
      if (q.derive !== undefined) {
        settled = q.derive(ctx)
      } else if (q.fixed !== undefined) {
        const fix = q.fixed(ctx, flag)
        if (fix !== null) {
          if ('refused' in fix) return refuse(fix.refused)
          const why = yield* validateAnswer(fix.answer)
          if (why !== null) return refuse(why)
          settled = fix.answer
        }
      }
      if (settled !== null) {
        const done = yield* q.write(settled, null, ctx)
        if ('refused' in done) return refuse(done.refused)
        entries.push({
          id: q.id,
          before: null,
          after: settled,
          wrote: done.wrote,
          pending: done.pending === true,
          asked: false,
          applies: true,
        })
        continue
      }

      const inForce = q.inForce === undefined ? null : yield* q.inForce(ctx)

      // A fault the run cannot repair (an exported variable, an App that does not answer) is refused by name.
      if (inForce !== null && 'fault' in inForce && inForce.fatal === true) return refuse(inForce.fault)
      // The environment decides: not asked, not written; a flag that differs is refused by name.
      if (inForce !== null && inForce.from === 'environment') {
        if ('fault' in inForce) return refuse(`${q.name}: ${inForce.fault}`)
        const unusable = q.refusesEnvironment?.(inForce.value) ?? null
        if (unusable !== null) return refuse(unusable)
        const sameAsExported =
          flag !== null &&
          (q.sameAsEnvironment !== undefined
            ? q.sameAsEnvironment(normalized(q, flag), inForce.value)
            : normalized(q, flag) === normalized(q, q.answerOf?.(inForce) ?? inForce.value))
        if (flag !== null && !sameAsExported) {
          return refuse(
            `${q.flag.split(',')[0]} ${flag}, but the environment names ${q.show?.(inForce.value) ?? inForce.value} ` +
              `for ${q.name}, and an exported value wins over the file. Unset it, or leave out the flag. Nothing was written`,
          )
        }
        entries.push({
          id: q.id,
          before: inForce,
          after: null,
          wrote: false,
          pending: false,
          asked: false,
          applies: true,
        })
        continue
      }

      if (inForce !== null && 'fault' in inForce) input.log(inForce.fault)

      // A flag answers on its own: the default is not read, so one that cannot be read does not hold it up.
      const read =
        q.systemDefault === undefined || flag !== null
          ? null
          : yield* q.systemDefault(ctx, { defaults, interactive: input.interactive })
      const system = read !== null && typeof read === 'object' ? null : read
      const systemRefused = read !== null && typeof read === 'object' ? read.refused : null
      const inForceAnswer =
        inForce === null
          ? null
          : 'fault' in inForce
            ? (inForce.value ?? null)
            : (q.answerOf?.(inForce) ?? inForce.value)
      const fallback = inForceAnswer ?? system

      const keptSaid = (input.kept ?? defaultKept)(entries.filter((e) => e.wrote))
      let answer: string
      let asked = false
      const noTerminal = !defaults && !input.interactive
      if (flag !== null) {
        answer = normalized(q, flag)
        const why = yield* validateAnswer(answer)
        if (why !== null) return refuse(why)
      } else if (q.confirm !== undefined && (input.defaults || !input.interactive)) {
        if (!input.defaults) return refuse(`${q.name} needs an answer: pass --defaults. ${keptSaid.kept}`)
        answer = 'yes'
      } else if (q.defaultsSwitch === true && defaults) {
        // The defaults are already on, so the switch is answered yes without a default of its own.
        answer = 'yes'
      } else if (q.defaultsSwitch === true && noTerminal) {
        // No terminal to ask on: the walk goes on, and nothing is written (#433).
        entries.push({
          id: q.id,
          before: inForce,
          after: null,
          wrote: false,
          pending: false,
          asked: false,
          applies: true,
        })
        continue
      } else if ((defaults && q.confirm === undefined) || !input.interactive) {
        // A confirmation is never answered from a default: past the switch it is asked, and here it has no terminal.
        if (fallback === null) {
          if (systemRefused !== null) return refuse(systemRefused)
          return refuse(`${q.name} needs an answer: pass ${q.flag}. ${keptSaid.kept}`)
        }
        answer = fallback
        const why = yield* validateAnswer(answer)
        if (why !== null) return refuse(why)
      } else {
        const asker = input.askers[q.id]
        if (asker === undefined) return refuse(`${q.name} has no asker here. ${keptSaid.kept}`)
        const got = yield* asker({
          question: {
            id: q.id,
            name: q.name,
            flag: q.flag,
            ...(q.why === undefined ? {} : { why: q.why }),
            ...(q.show === undefined ? {} : { show: q.show }),
            validate: (a) => validateAnswer(a),
          },
          ctx,
          default: fallback,
          inForce,
          kept: keptSaid.kept,
          ...(keptSaid.startOver === undefined ? {} : { startOver: keptSaid.startOver }),
          why: q.why ?? [],
        })
        if ('refused' in got) return refuse(got.refused)
        answer = normalized(q, got.answer)
        asked = true
      }
      if (q.confirm !== undefined && answer !== 'yes')
        return refuse(typeof q.confirm.declined === 'string' ? q.confirm.declined : q.confirm.declined(ctx))

      const done = yield* q.write(answer, inForce, ctx)
      if ('refused' in done) return refuse(done.refused)
      entries.push({
        id: q.id,
        before: inForce,
        after: answer,
        wrote: done.wrote,
        pending: done.pending === true,
        asked,
        applies: true,
      })
      if (q.defaultsSwitch === true && answer === 'yes') defaults = true
    }
    return { entries, deferred }
  })
}
