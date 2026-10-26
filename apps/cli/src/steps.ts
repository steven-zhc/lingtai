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
import * as clack from '@clack/prompts'
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
        spinner = (how.spinner ?? (() => clack.spinner()))()
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
