/**
 * The release notes' *Decisions* section (#777): the ADRs touched by an
 * `NNNN: <sentence>` commit directly on the first-parent line since the
 * previous release. ADR edits inside an agent branch are in the tickets section.
 */
import { readFileSync } from 'node:fs'

const ADR_COMMIT = /^(\d{4}): (.+)$/
const ADR_FILE = /^doc\/decisions\/(\d{4})-[^/]+\.md$/

export type DecisionCommit = { adr: string; sentence: string }

/** ADR commits from first-parent subjects: anchored, in log order. */
export function decisionCommits(subjects: string[]): DecisionCommit[] {
  const out: DecisionCommit[] = []
  for (const s of subjects) {
    const m = ADR_COMMIT.exec(s)
    if (m) out.push({ adr: m[1]!, sentence: m[2]! })
  }
  return out
}

export function renderDecisions(input: {
  repo: string
  tag: string
  prev: string | undefined
  commits: DecisionCommit[]
  /** Raw `git ls-tree --name-only <tag> doc/decisions/` lines. */
  files: string[]
}): string {
  const { repo, tag, prev, commits, files } = input
  if (!prev) return '## Decisions\n\nNo earlier release to compare against.\n'
  if (commits.length === 0) return ''
  const fileOf = new Map<string, string>()
  for (const f of files) {
    const m = ADR_FILE.exec(f)
    if (m && !fileOf.has(m[1]!)) fileOf.set(m[1]!, f)
  }
  const sentences = new Map<string, string[]>()
  for (const c of commits) sentences.set(c.adr, [c.sentence, ...(sentences.get(c.adr) ?? [])]) // log is newest first
  const out = ['## Decisions', '']
  for (const adr of [...sentences.keys()].sort()) {
    const file = fileOf.get(adr)
    out.push(
      file ? `- [${adr}](https://github.com/${repo}/blob/${tag}/${file})` : `- ${adr} (no file at ${tag})`,
      ...sentences.get(adr)!.map((s) => `  - ${s}`),
    )
  }
  return out.join('\n') + '\n'
}

if (import.meta.main) {
  // decisions-changed.ts <repo> <tag> [<commits file> <ls-tree file> <previous tag>]
  const [repo, tag, commitsFile, filesFile, prev] = process.argv.slice(2)
  if (!repo || !tag)
    throw new Error('usage: decisions-changed.ts <repo> <tag> [<commits file> <ls-tree file> <previous tag>]')
  if (!commitsFile || !filesFile || !prev) {
    process.stdout.write(renderDecisions({ repo, tag, prev: undefined, commits: [], files: [] }))
  } else {
    const lines = (f: string) => readFileSync(f, 'utf8').split('\n')
    process.stdout.write(
      renderDecisions({ repo, tag, prev, commits: decisionCommits(lines(commitsFile)), files: lines(filesFile) }),
    )
  }
}
