/**
 * What a local `init` and `add` end on (0121 §1): the card, the price hints,
 * the ready line, and doctor's short blocks when there is something to fix.
 *
 * Imports nothing from `doctor.ts` by value — `init.ts` reaches this, and its
 * header warns that an eager log read breaks a fresh machine.
 */
import { paint } from '@lingtai/env/colour'
import { Cause, Effect } from 'effect'

import type { DoctorReport } from './doctor.ts'
import { type ReadyInput, renderReadyLine, renderSetupCard, type SetupCardFacts } from './setup-card.ts'

/** The report `lingtai doctor` would print: its counts, the to-fix summary, and the short blocks formatted. */
export interface SetupDoctor {
  report: Pick<DoctorReport, 'ok' | 'notChecked' | 'deferred'>
  toFix: { count: number; failed: boolean }
  blocks: string
  /** Doctor's first fix (`nextOf`); absent when there is nothing to fix. */
  next?: string | undefined
}

/** Dynamic, never a static import of `./doctor.ts`. Never `releaseCheck`: that request is `doctor` and `upgrade`'s alone. */
export const liveSetupDoctorEffect = (): Effect.Effect<SetupDoctor> =>
  Effect.gen(function* () {
    const { doctorReportEffect, formatReport, nextOf, toFixSummary } = yield* Effect.promise(
      () => import('./doctor.ts'),
    )
    const { doctorProgress } = yield* Effect.promise(() => import('./steps.ts'))
    const progress = doctorProgress({ stdout: process.stdout, stderr: process.stderr, json: false })
    const report = yield* doctorReportEffect({ onProgress: progress.onProgress }).pipe(
      Effect.ensuring(Effect.sync(() => progress.clear())),
    )
    return { report, toFix: toFixSummary(report), blocks: formatReport(report), next: nextOf(report.results) }
  })

/** The face of `liveSetupDoctorEffect` for `init.ts` and `add.ts`, which hand their world a promise `doctor`. */
export function liveSetupDoctor(): Promise<SetupDoctor> {
  return Effect.runPromise(liveSetupDoctorEffect())
}

/** The command a failed doctor closes on: its first fix, or `lingtai doctor --verbose` when it gave none or did not finish. */
export const DOCTOR_VERBOSE = 'lingtai doctor --verbose'

/** Prints the end of a local setup. `failed` is true when doctor failed or did not finish; `fix` is then what to close on. */
export const printSetupEndEffect = (
  world: { log: (line: string) => void; doctor: () => Effect.Effect<SetupDoctor, unknown> },
  facts: SetupCardFacts,
  hints: readonly string[],
): Effect.Effect<{ failed: boolean; fix?: string }> =>
  Effect.gen(function* () {
    let blocks: string | null = null
    const doctor = yield* Effect.suspend(() => world.doctor()).pipe(
      Effect.map((done) => ({ done }) as const),
      Effect.catchCause((cause) => {
        const err = Cause.squash(cause) as Error
        return Effect.succeed({ threw: err.message || String(err) } as const)
      }),
    )
    let ready: ReadyInput
    let failed: boolean
    let fix: string | undefined
    if ('threw' in doctor) {
      ready = { threw: doctor.threw }
      failed = true
      fix = DOCTOR_VERBOSE
    } else {
      const { done } = doctor
      ready = { report: done.report, toFix: done.toFix }
      // `failed` counts failures only, never warnings: a fresh machine nearly always warns.
      failed = done.toFix.failed
      if (failed) fix = done.next ?? DOCTOR_VERBOSE
      if (done.toFix.count > 0) blocks = done.blocks
    }
    world.log(renderSetupCard(facts))
    for (const line of hints) world.log(paint.muted(line))
    world.log('')
    world.log(renderReadyLine(ready, facts.recipePath))
    if (blocks !== null) world.log(blocks)
    return fix === undefined ? { failed } : { failed, fix }
  })

/** Wraps a promise `doctor` for `printSetupEndEffect`; a rejection keeps the value it threw. */
const liftDoctor = (world: { log: (line: string) => void; doctor: () => Promise<SetupDoctor> }) => ({
  log: world.log,
  doctor: () => Effect.tryPromise({ try: () => world.doctor(), catch: (e) => e }),
})

/** The face of `printSetupEndEffect` for `init.ts` and `add.ts`, whose worlds hold a promise `doctor`. */
export function printSetupEnd(
  world: { log: (line: string) => void; doctor: () => Promise<SetupDoctor> },
  facts: SetupCardFacts,
  hints: readonly string[],
): Promise<{ failed: boolean; fix?: string }> {
  return Effect.runPromise(printSetupEndEffect(liftDoctor(world), facts, hints))
}
