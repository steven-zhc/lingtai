/**
 * `['--local', '/repo', '--build', 'npm test']`, as the `{ flags, repeated }`
 * `initCommand` and `addFlow` take (#620) — so a unit test keeps writing the
 * command line it means rather than the record `flagsOf` makes of it.
 *
 * A flag followed by another flag or by nothing is a boolean (`--defaults`,
 * which is the only one these commands have); everything else takes the next
 * token. A bare token is the positional.
 */
export function flagsFromArgv(argv: readonly string[]): {
  positional?: string
  flags: Record<string, string>
  repeated: Record<string, string[]>
} {
  const flags: Record<string, string> = {}
  const repeated: Record<string, string[]> = {}
  let positional: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!token.startsWith('--')) {
      positional = token
      continue
    }
    const name = token.slice(2)
    const value = name === 'defaults' ? '' : argv[++i]!
    flags[name] = value
    ;(repeated[name] ??= []).push(value)
  }
  return positional === undefined ? { flags, repeated } : { positional, flags, repeated }
}
