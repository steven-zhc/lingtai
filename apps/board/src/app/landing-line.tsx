import Link from 'next/link'

import type { LandingLine } from '@/lib/landing-line'

/** `landed <merge> · build ✓ · review ✓`, with a step's sha only where it is not the head. */
export function LandingLineView({ line }: { line: LandingLine }) {
  const parts: React.ReactNode[] = [
    <span key="merge" className="mono">
      landed {line.merge.slice(0, 7)}
    </span>,
    ...line.items.map((i) => (
      <span key={i.step}>
        {i.step} {i.ok ? '✓' : i.state}
        {i.onSha === null ? null : <span className="mono"> on {i.onSha.slice(0, 7)}</span>}
      </span>
    )),
  ]
  if (line.flaky.count > 0) {
    parts.push(
      <Link key="flaky" href="/backlog" title={line.flaky.tests.join('\n')} style={{ color: 'var(--signal)' }}>
        {line.flaky.count} flaky test{line.flaky.count === 1 ? '' : 's'}
      </Link>,
    )
  }
  return <p className="ameta">{parts.flatMap((p, i) => (i === 0 ? [p] : [' · ', p]))}</p>
}
