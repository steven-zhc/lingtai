'use client'

import { Children, type ReactNode, useId } from 'react'

const SHELLS = ['Bash', 'Zsh', 'Fish'] as const

export function ShellTabs({ children }: { children: ReactNode }) {
  const id = useId()
  const examples = Children.toArray(children)

  // Native radios keep the static export usable before (or without) hydration.
  return (
    <form className="shell-tabs">
      <fieldset className="shell-tab-list">
        <legend className="visually-hidden">Choose your shell</legend>
        {SHELLS.map((shell, index) => (
          <label key={shell}>
            <input type="radio" name={`${id}-shell`} value={shell.toLowerCase()} defaultChecked={index === 0} />
            <span>{shell}</span>
          </label>
        ))}
      </fieldset>
      {SHELLS.map((shell, index) => (
        <div key={shell} className="shell-panel" data-shell={shell.toLowerCase()}>
          {examples[index]}
        </div>
      ))}
    </form>
  )
}
