/**
 * The onboarding wizard's page (#164) is gone (#401, #391): writing a recipe
 * happens in the terminal now, through `pnpm lingtai add`. This path stays
 * only because `/setup/repository`'s own screen used to link here with
 * `?repo=` — a bookmarked one of those should answer something rather than
 * 404.
 */
import { TerminalScreen } from '../terminal.tsx'

export default function Wizard() {
  return <TerminalScreen />
}
