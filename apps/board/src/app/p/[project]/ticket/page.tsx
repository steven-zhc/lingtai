import { Home } from '@/app/page'

export const dynamic = 'force-dynamic'

/** `/p/<project>/ticket`: the home page for one project (#1498). */
export default async function ProjectHome({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params
  return Home({ project: decodeURIComponent(project) })
}
