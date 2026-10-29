/**
 * The phases of a command that takes a while (#622): `restart` and `service`
 * show *checking*, *draining*, *checking again*, *starting* as steps, and a long
 * wait still says what it is waiting for.
 *
 * A step line is **added** to what a command already printed and replaces none of
 * it. The one line that changes behaviour is `progress`, the repeated "still
 * draining after 300s" sentence: on a terminal it moves a spinner's message
 * rather than adding a line of scrollback, and off one it is written as it
 * always was — a launchd log and a test's collector are not terminals, and
 * piped output is the same bytes either way (`prompt.ts`).
 */
import { coloured, paint } from '@lingtai/env/colour'
import ora from 'ora'

import type { DoctorProgress } from './doctor.ts'
import { interactivity, refusal } from './prompt.ts'

export interface Steps {
  /** A phase begins: one line, its label. */
  begin(label: string): void
  /** A repeated "still waiting" line. */
  progress(line: string): void
  /** The phase is over; anything live is cleared before the next line is written. */
  end(): void
}

/** The part of a spinner `Steps` uses, so a test passes a fake. */
export interface Spinner {
  start(message: string): void
  message(message: string): void
  clear(): void
}

/**
 * `ora`, with `discardStdin` off. Left on, ora puts stdin in raw mode while it spins, and raw mode
 * turns Ctrl+C into a keystroke rather than a SIGINT — so the handler a drain's wait installs
 * (`waitForTheLock`, which withdraws the request) never ran. Off, Ctrl+C stays a signal.
 * `hideCursor` is off too: its default goes through restore-cursor, which registers a SIGINT listener
 * on a real terminal and so changes `process.listenerCount('SIGINT')` for good.
 * ora wraps a long message over as many rows as it needs and redraws them in place.
 */
export function oraSpinner(stream: NodeJS.WriteStream = process.stdout): Spinner {
  const spinner = ora({ text: '', stream, discardStdin: false, hideCursor: false, isEnabled: true })
  return {
    start(message) {
      spinner.start(message)
    },
    message(message) {
      spinner.text = message
    },
    clear() {
      spinner.stop()
    },
  }
}

export function createSteps(log: (line: string) => void, how: { live?: boolean; spinner?: () => Spinner } = {}): Steps {
  const live = how.live ?? (refusal('', interactivity(false)) === null && coloured(process.stdout))
  let spinner: Spinner | null = null
  const clear = (): void => {
    spinner?.clear()
    spinner = null
  }
  return {
    begin(label) {
      clear()
      log(paint.accent(label))
      // The phase may take a while with nothing else said; the spinner shows it is alive.
      if (live) {
        spinner = (how.spinner ?? (() => oraSpinner()))()
        spinner.start(`${label}…`)
      }
    },
    progress(line) {
      if (!live) {
        log(line)
        return
      }
      if (spinner === null) {
        spinner = (how.spinner ?? (() => oraSpinner()))()
        spinner.start(line)
      } else spinner.message(line)
    },
    end: clear,
  }
}

/** No phases shown: what a caller that passes no `Steps` gets. */
export const noSteps: Steps = {
  begin() {},
  progress() {},
  end() {},
}

/**
 * The line `lingtai doctor` keeps on stderr while it runs: a spinner, the step in flight and how many
 * rows are done. Drawn only where all of stderr, stdout and colour are live (`lingtai doctor | less`
 * has a piped stdout and a TTY stderr), and never under `--json`. No signal listener (0121 §10).
 */
export function doctorProgress(how: {
  stdout: { isTTY?: boolean }
  stderr: { isTTY?: boolean }
  json: boolean
  spinner?: () => Spinner
}): { onProgress: (p: DoctorProgress) => void; clear: () => void } {
  const live = !how.json && how.stderr.isTTY === true && how.stdout.isTTY === true && coloured(how.stderr)
  if (!live) return { onProgress: () => {}, clear: () => {} }
  let spinner: Spinner | null = null
  let label = ''
  const text = (done: number): string => `checking ${label} · ${done} done`
  return {
    onProgress(p) {
      if (p.phase === 'start') {
        label = p.label
        if (spinner === null) {
          spinner = (how.spinner ?? (() => oraSpinner(process.stderr)))()
          spinner.start(text(p.done))
        } else spinner.message(text(p.done))
      } else spinner?.message(text(p.done))
    },
    clear() {
      spinner?.clear()
      spinner = null
    },
  }
}
