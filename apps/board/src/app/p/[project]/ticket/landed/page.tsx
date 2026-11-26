import { LandedBody } from '@/app/landed/page'
import type { LandedParams } from '@/lib/landed.ts'

export const dynamic = 'force-dynamic'

/** `/p/<project>/ticket/landed`: what Lingtai changed in one project (#1498). */
export default async function ProjectLanded({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>
  searchParams: Promise<LandedParams>
}) {
  const { project } = await params
  return LandedBody({ project: decodeURIComponent(project), params: await searchParams })
}
