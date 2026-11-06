/** The footer's reading (#906), fetched by the browser once per page load. */
import { loadFooter } from '@/lib/footer'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return Response.json(await loadFooter())
}
