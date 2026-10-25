/**
 * `lingtai --help` and `lingtai <command> --help` (0121 §6–8, #617).
 *
 * Answered from `commands.ts` alone, with no project, no log and no network:
 * the imports here are the definitions, the renderers and the colour module,
 * and nothing that reads a file. Rendering returns strings; `helpCommand` is
 * the one place that prints.
 */
import { COMMANDS, GROUPS, definitionOf, isCommand } from './commands.ts'
import { applyNoColor, heading, keyValues, section } from './output.ts'

/** The root listing: four groups, one line per command. */
export function rootHelp(): string {
  const groups = GROUPS.map((group) =>
    section(group, keyValues(COMMANDS.filter((c) => c.group === group).map((c) => [c.name, c.task] as const))),
  )
  return [
    heading('lingtai — event-sourced scheduler for autonomous code agents'),
    '',
    groups.join('\n\n'),
    '',
    'next: lingtai <command> --help',
  ].join('\n')
}

/** One command: what it is for, its usage and flags, whether it changes anything, and examples. */
export function commandHelp(name: Parameters<typeof definitionOf>[0]): string {
  const c = definitionOf(name)
  return [
    heading(`lingtai ${c.name}`) + `  ${c.task}`,
    '',
    section('usage', c.usage),
    '',
    c.effect === 'reads' ? 'reads only — it changes nothing' : 'changes state — it is not read-only',
    '',
    section('examples', c.examples),
  ].join('\n')
}

/** The first argument that is not a flag, which is the command a question is about. */
function commandAsked(argv: readonly string[]): string | undefined {
  const first = argv[0]
  if (first === 'help') return argv.find((a, i) => i > 0 && !a.startsWith('-'))
  return first !== undefined && !first.startsWith('-') ? first : undefined
}

/** Prints the help `argv` asked for and returns the exit code (0121 §8). */
export function helpCommand(argv: readonly string[]): number {
  if (argv.includes('--no-color')) applyNoColor()
  const asked = commandAsked(argv)
  if (asked === undefined) {
    // Running nothing is not a question, so a script that does it keeps failing.
    const none = argv.length === 0
    ;(none ? process.stderr : process.stdout).write(`${rootHelp()}\n`)
    return none ? 2 : 0
  }
  if (!isCommand(asked)) {
    process.stderr.write(`unknown command "${asked}"\n\n${rootHelp()}\n`)
    return 2
  }
  process.stdout.write(`${commandHelp(asked)}\n`)
  return 0
}
