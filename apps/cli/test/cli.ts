import { Effect } from 'effect'

import { cli } from '../src/cli.ts'

/** `cli` run to its exit code: the one place a test turns the Effect back into a promise. */
export const runCli = (argv: Parameters<typeof cli>[0], deps?: Parameters<typeof cli>[1]): Promise<number> =>
  Effect.runPromise(cli(argv, deps))
