/**
 * Step 0, after the App exists: which repository (#168), now in the terminal
 * (#401, #391). This path still has to answer for three callers it cannot
 * tell apart from any other request:
 *
 * - **Every App this board ever created carries this as its manifest's
 *   `setupUrl`** (`github-app/start/route.ts`), so `installed/route.ts`'s 303
 *   lands here however long ago the App was made, and on GitHub's side there
 *   is no changing that address now.
 * - **`lingtai init` opens this in a browser and prints it**
 *   (`apps/cli/src/init.ts`).
 * - **The board's own `+`** (`apps/board/src/app/projects.tsx`) links here.
 *
 * So the path stays and the screen it serves is the one every setup page that
 * used to decide something is reduced to.
 */
import { TerminalScreen } from '../terminal.tsx'

export const dynamic = 'force-dynamic'

export default async function PickRepository({ searchParams }: { searchParams: Promise<{ requested?: string }> }) {
  const params = await searchParams
  return <TerminalScreen requested={params.requested === '1'} />
}
