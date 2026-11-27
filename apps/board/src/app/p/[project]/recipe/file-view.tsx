'use client'

import dynamic from 'next/dynamic.js'
import { useState } from 'react'

// Loaded the way the editor is: never on the server (CodeMirror touches `document`), and a failed
// chunk leaves the `<pre>`, which is why it is caught here rather than boundaried.
const YamlView = dynamic(() => import('./yaml-view').catch(() => ({ default: () => null })), {
  ssr: false,
})

/** The text as a `<pre>` until the highlighted view reports ready, and for good if its chunk fails. */
export function FileView({ text }: { text: string }) {
  const [ready, setReady] = useState(false)
  return (
    <>
      {ready ? null : <pre className="s2-yaml">{text}</pre>}
      <YamlView text={text} onReady={() => setReady(true)} />
    </>
  )
}
