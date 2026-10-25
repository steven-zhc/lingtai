'use client'

import { Children, type ReactNode, useId } from 'react'

const SHELLS = [
  { name: 'POSIX shell', value: 'posix' },
  { name: 'Fish', value: 'fish' },
] as const

export function ShellTabs({ children }: { children: ReactNode }) {
  const id = useId()
  const examples = Children.toArray(children)

  // Native radios keep the static export usable before (or without) hydration.
  return (
    <form className="shell-tabs">
      <fieldset className="shell-tab-list">
        <legend className="visually-hidden">Choose your shell</legend>
        {SHELLS.map((shell, index) => (
          <label key={shell.value}>
            <input type="radio" name={`${id}-shell`} value={shell.value} defaultChecked={index === 0} />
            <span>{shell.name}</span>
          </label>
        ))}
      </fieldset>
      {SHELLS.map((shell, index) => (
        <div key={shell.value} className="shell-panel" data-shell={shell.value}>
          {examples[index]}
        </div>
      ))}
    </form>
  )
}
