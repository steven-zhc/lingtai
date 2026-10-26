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
import { paint } from '@lingtai/env/colour'
import ora from 'ora'

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
 * ora wraps a long message over as many rows as it needs and redraws them in place.
 */
export function oraSpinner(stream: NodeJS.WriteStream = process.stdout): Spinner {
  const spinner = ora({ text: '', stream, discardStdin: false, isEnabled: true })
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
  const live = how.live ?? refusal('', interactivity(false)) === null
  let spinner: Spinner | null = null
  const clear = (): void => {
    spinner?.clear()
    spinner = null
  }
  return {
    begin(label) {
      clear()
      log(paint.accent(label))
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
