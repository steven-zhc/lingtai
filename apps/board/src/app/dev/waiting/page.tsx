import Link from 'next/link'
import { notFound } from 'next/navigation'

import { CASE_NAMES } from '../../../../test/visual-waiting.ts'

export default function WaitingGallery() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <main style={{ padding: 24, maxWidth: 1280, margin: 'auto' }}>
      <h1>0118 Waiting visual gallery</h1>
      <p>Local fixtures only. Choose a case and capture the isolated card or task page.</p>
      <ul>
        {CASE_NAMES.map((name) => (
          <li key={name}>
            {name}: <Link href={`/dev/waiting/${name}/card`}>card</Link> ·{' '}
            <Link href={`/dev/waiting/${name}/task`}>task page</Link>
          </li>
        ))}
      </ul>
      <h2>Desktop previews</h2>
      {CASE_NAMES.map((name) => (
        <section key={name}>
          <h3>{name}</h3>
          <iframe title={`${name} card`} src={`/dev/waiting/${name}/card`} sandbox="" width="440" height="300" />
          <iframe title={`${name} task`} src={`/dev/waiting/${name}/task`} sandbox="" width="1200" height="900" />
        </section>
      ))}
    </main>
  )
}
