import { redirect } from 'next/navigation'

import { homePath } from '@/lib/paths'

/** `/p/<project>` is a way in, not a page: 307, since the address is new and may one day be a page of its own (#1498). */
export default async function ProjectRoot({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params
  redirect(homePath(decodeURIComponent(project)))
}
