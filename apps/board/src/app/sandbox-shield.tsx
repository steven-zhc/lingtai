import { GLYPH, type SandboxStateName } from '../lib/sandbox-state.ts'

/** The one shield (#1183), drawn as SVG so every state sits at the same height. Pure: the colour is the CSS's. */
export function SandboxShield({ state }: { state: SandboxStateName }) {
  return (
    <span className="sbx-mark" aria-hidden="true">
      <svg className="sbx-shield" viewBox="0 0 16 16" focusable="false">
        <path d="M8 1.25 13.75 3.4v4.1c0 3.35-2.35 5.95-5.75 7.25C4.6 13.45 2.25 10.85 2.25 7.5V3.4Z" />
        {GLYPH[state] === '' ? null : <path className="sbx-glyph" d={GLYPH[state]} />}
      </svg>
    </span>
  )
}
