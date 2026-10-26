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
 * A spinner that only writes to `out`. `@clack/prompts`' own puts stdin in raw mode while it
 * runs and answers Ctrl+C with `process.exit(0)`, so the SIGINT handler a drain's wait installs
 * (`waitForTheLock`, which withdraws the request) never ran and the command reported success.
 * This one never touches stdin: Ctrl+C stays a signal.
 */
export function lineSpinner(out: { write(text: string): unknown; columns?: number } = process.stdout): Spinner {
  const frames = ['◒', '◐', '◓', '◑']
  let text = ''
  let timer: ReturnType<typeof setInterval> | undefined
  let i = 0
  const draw = (): void => {
    const room = Math.max(10, (out.columns ?? 80) - 3)
    out.write(`\r\x1b[2K${frames[i++ % frames.length]} ${text.slice(0, room)}`)
  }
  return {
    start(message) {
      text = message
      draw()
      timer = setInterval(draw, 120)
      timer.unref()
    },
    message(message) {
      text = message
    },
    clear() {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
      out.write('\r\x1b[2K')
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
        spinner = (how.spinner ?? (() => lineSpinner()))()
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
