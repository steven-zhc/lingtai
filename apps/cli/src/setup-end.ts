/**
 * What a local `init` and `add` end on (0121 §1): the card, the price hints,
 * the ready line, and doctor's short blocks when there is something to fix.
 *
 * Imports nothing from `doctor.ts` by value — `init.ts` reaches this, and its
 * header warns that an eager log read breaks a fresh machine.
 */
import { paint } from '@lingtai/env/colour'

import type { DoctorReport } from './doctor.ts'
import { type ReadyInput, renderReadyLine, renderSetupCard, type SetupCardFacts } from './setup-card.ts'

/** The report `lingtai doctor` would print: its counts, the to-fix summary, and the short blocks formatted. */
export interface SetupDoctor {
  report: Pick<DoctorReport, 'ok' | 'notChecked' | 'deferred'>
  toFix: { count: number; failed: boolean }
  blocks: string
}

/** Dynamic, never a static import of `./doctor.ts`. Never `releaseCheck`: that request is `doctor` and `upgrade`'s alone. */
export async function liveSetupDoctor(): Promise<SetupDoctor> {
  const { doctorReport, formatReport, toFixSummary } = await import('./doctor.ts')
  const { doctorProgress } = await import('./steps.ts')
  const progress = doctorProgress({ stdout: process.stdout, stderr: process.stderr, json: false })
  let report
  try {
    report = await doctorReport({ onProgress: progress.onProgress })
  } finally {
    progress.clear()
  }
  return { report, toFix: toFixSummary(report), blocks: formatReport(report) }
}

/** Prints the end of a local setup. `failed` is true when doctor failed or did not finish. */
export async function printSetupEnd(
  world: { log: (line: string) => void; doctor: () => Promise<SetupDoctor> },
  facts: SetupCardFacts,
  hints: readonly string[],
): Promise<{ failed: boolean }> {
  let ready: ReadyInput
  let blocks: string | null = null
  let failed: boolean
  try {
    const done = await world.doctor()
    ready = { report: done.report, toFix: done.toFix }
    // `failed` counts failures only, never warnings: a fresh machine nearly always warns.
    failed = done.toFix.failed
    if (done.toFix.count > 0) blocks = done.blocks
  } catch (err) {
    ready = { threw: (err as Error).message || String(err) }
    failed = true
  }
  world.log(renderSetupCard(facts))
  for (const line of hints) world.log(paint.muted(line))
  world.log('')
  world.log(renderReadyLine(ready, facts.recipePath))
  if (blocks !== null) world.log(blocks)
  return { failed }
}
