import { BacklogBody } from '@/app/backlog/page'

export const dynamic = 'force-dynamic'

/** `/p/<project>/backlog`: one project's backlog, reached by address only (#1498). */
export default async function ProjectBacklog({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params
  return BacklogBody({ project: decodeURIComponent(project) })
}
