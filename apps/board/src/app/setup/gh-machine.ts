/**
 * Whether this machine's GitHub auth is `gh` (#713), read per call so a board
 * started before `github.auth` was written still answers it (0114 §6). A
 * refused value is not `gh`: diagnosing it is `lingtai doctor`'s job, and a
 * help page that threw would be a 500 on the machine that needs the help.
 */
import { githubAuthKind } from '@lingtai/env'

export function isGhMachine(): boolean {
  try {
    return githubAuthKind() === 'gh'
  } catch {
    return false
  }
}
