/**
 * The sandbox step of "add a repository" (#1160): what the proposal says about this host, and the sentences
 * both inputs show. **Pure** — the host check itself is injected (`ProposalReaders.host`), so nothing here
 * loads srt, and the board's client graph never reaches it except through `import type`.
 */
import { isNetworkEntry, type HostVerdict } from '@lingtai/recipe'

/** What to install on a host that cannot sandbox yet — `@lingtai/sandbox`'s `InstallAdvice`, which the caller reads. */
export interface SandboxInstall {
  readonly missing: readonly string[]
  readonly command: string
}

/** The step's line of the `Proposal`: the host's answer, the install advice for it, and the built-in allowlist. */
export interface SandboxProposal {
  verdict: HostVerdict
  /** `null` for a platform that cannot be sandboxed at all. */
  install: SandboxInstall | null
  builtIns: readonly string[]
}

/** What turning the sandbox off gives up — one line, shown wherever off is chosen. */
export const SANDBOX_OFF_LINE =
  'Agents and build commands will reach anything your user can: your other repositories, your credentials, the network.'

/** The sentence for a host that cannot provide the sandbox, srt's own sentences as srt wrote them; `null` where it can. */
export function sandboxCannotSentence(p: SandboxProposal): string | null {
  if (p.verdict.can) return null
  const why = [p.verdict.reason, ...p.verdict.sentences].join('; ')
  const install = p.install === null ? 'This platform cannot run the sandbox.' : `Install: ${p.install.command}.`
  return `This machine cannot run the sandbox yet: ${why}. ${install} The project will run without one until you do.`
}

/** The extra hosts typed one per line or comma-separated: trimmed, none empty, none twice. */
export function parseHosts(answer: string): string[] {
  const seen = new Set<string>()
  for (const part of answer.split(/[\n,]/)) {
    const host = part.trim()
    if (host !== '') seen.add(host)
  }
  return [...seen]
}

/** Why a typed host is not one the block accepts, by name; `null` where every one is. */
export function hostsRefusal(hosts: readonly string[]): string | null {
  const bad = hosts.find((h) => !isNetworkEntry(h))
  return bad === undefined
    ? null
    : `${bad} is not a host the sandbox accepts — a name with a dot, or *. and a name, with no scheme, port or path`
}
