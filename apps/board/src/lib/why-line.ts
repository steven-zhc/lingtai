/**
 * The Queued column's *why nothing runs* line, as data (#1216, 0122 §8): which colour it takes and what
 * it says, from #1215's `Root`. Pure and import-light, so the column and its test share it.
 *
 * **The line is not a second banner.** A lock root is worded from the lock itself — its name and *see
 * above* — never from `root.sentence`, which carries the reset and the Lift the banner alone says.
 * Every other root's words are #1215's own, verbatim.
 */
import type { Root } from '@lingtai/conductor/why-nothing-runs'
import { accountWords, limitName, type Lock } from '@lingtai/domain'

export type WhyTone = 'person' | 'red' | 'lock' | 'down' | ''

export type WhySegment =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'ticket'; text: string; ref: number }

export interface WhyLine {
  tone: WhyTone
  segments: WhySegment[]
}

/** What holds a project, named in a few words and never dated: the banner carries the reset. */
export function lockName(project: string, lock: Lock): string {
  switch (lock.kind) {
    case 'account': {
      if (lock.named != null) return limitName(lock.account, lock.named.kind)
      const words = accountWords(lock.account)
      return `${words.name}'s ${words.limit}`
    }
    case 'ceiling':
      return "today's spend ceiling"
    case 'paused':
      return `${project}'s pause`
  }
}

const TONES: Partial<Record<Root['root'], WhyTone>> = {
  lock: 'lock',
  'locks-unread': 'lock',
  'base-red': 'red',
  'base-unreadable': 'red',
  'no-daemon': 'down',
  'beacon-unread': 'down',
  drain: 'down',
}

/** `a \`b\` c` as text, code, text. A ticket's `#N` is a link when the root says which it is. */
function segmentsOf(sentence: string, ref: number | null): WhySegment[] {
  const out: WhySegment[] = []
  sentence.split('`').forEach((part, i) => {
    if (part === '') return
    if (i % 2 === 1) return void out.push({ kind: 'code', text: part })
    const mark = ref === null ? -1 : part.indexOf(`#${ref}`)
    if (ref === null || mark < 0) return void out.push({ kind: 'text', text: part })
    const link = `#${ref}`
    if (mark > 0) out.push({ kind: 'text', text: part.slice(0, mark) })
    out.push({ kind: 'ticket', text: link, ref })
    if (mark + link.length < part.length) out.push({ kind: 'text', text: part.slice(mark + link.length) })
  })
  return out
}

export function whyLine(project: string, root: Root): WhyLine {
  if (root.root === 'lock' && root.lock !== undefined) {
    return { tone: 'lock', segments: [{ kind: 'text', text: `held by ${lockName(project, root.lock)} — see above` }] }
  }
  // A chain whose end waits on a person is the one the person can end; any other chain is neutral.
  const person = root.root === 'chain' && root.on?.waits === true
  return {
    tone: person ? 'person' : (TONES[root.root] ?? ''),
    segments: segmentsOf(root.sentence, root.root === 'chain' && root.on?.waits ? root.on.ref : null),
  }
}
