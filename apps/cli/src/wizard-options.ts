/**
 * The options `init` and `add` share, written once (#620), and the one function
 * that turns what `@effect/cli` parsed back into the `{ flags, repeated }` pair
 * the wizards read — the shape the hand parsers used to return, so the ~twenty
 * refusals that look a key up in it did not have to be retyped.
 *
 * Every option is text on purpose: `--store` and `--port` are refused by
 * `init.ts` in its own words, and those words are what scripts and tests read.
 */
import { Options } from '@effect/cli'
import type { Option } from 'effect'

const text = (name: string) => Options.text(name).pipe(Options.optional)

/** The recipe flags `init` and `add` both take. */
export const recipeOptions = {
  base: text('base'),
  tickets: text('tickets'),
  kinds: text('kinds'),
  agent: text('agent'),
  model: text('model'),
  reviewer: text('reviewer'),
  'reviewer-model': text('reviewer-model'),
  install: text('install'),
  build: Options.text('build').pipe(Options.repeated),
  land: text('land'),
  rounds: text('rounds'),
  wall: text('wall'),
  budget: text('budget'),
  defaults: Options.boolean('defaults'),
}

export const initOptions = {
  store: text('store'),
  'database-url': text('database-url'),
  port: text('port'),
  project: text('project'),
  local: text('local'),
  'github-app': text('github-app'),
  ...recipeOptions,
}

export const addOptions = {
  github: text('github'),
  local: text('local'),
  project: text('project'),
  'github-app': text('github-app'),
  ...recipeOptions,
}

export interface WizardFlags {
  flags: Record<string, string>
  repeated: Record<string, string[]>
}

/**
 * An absent option is an absent key; `--defaults` is `''`; `flags.build` is the
 * last `--build` and `repeated.build` is every one, in order.
 */
export function flagsOf(parsed: Record<string, Option.Option<string> | readonly string[] | boolean>): WizardFlags {
  const flags: Record<string, string> = {}
  const repeated: Record<string, string[]> = {}
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === 'boolean') {
      if (value) {
        flags[name] = ''
        repeated[name] = ['']
      }
    } else if (Array.isArray(value)) {
      if (value.length > 0) {
        flags[name] = value[value.length - 1]!
        repeated[name] = [...value]
      }
    } else if ((value as Option.Option<string>)._tag === 'Some') {
      const given = (value as Option.Some<string>).value
      flags[name] = given
      repeated[name] = [given]
    }
  }
  return { flags, repeated }
}
