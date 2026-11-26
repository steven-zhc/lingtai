/**
 * Two answers, and they are not the same kind. An old address (`/task/…`,
 * `/pr/…`, `/recipe/…`, `?project=`) is answered **308** with its new one
 * (#1498): the old URL never comes back, so a browser may keep it. A bare `/`
 * with a remembered project is answered **307** to that project's home
 * (#1435): the memory changes, so it must never be cached. **This file never
 * writes the cookie**: only `rememberProject`, on a person's click, does.
 */
import { NextResponse, type NextRequest } from 'next/server'

import { legacyRedirect } from './lib/legacy.ts'
import { homeRedirect, rememberedProject } from './lib/remember.ts'

export function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl
  const moved = legacyRedirect(pathname, searchParams)
  if (moved !== null) return NextResponse.redirect(new URL(moved, request.url), 308)
  if (pathname !== '/') return NextResponse.next()
  const target = homeRedirect(searchParams, rememberedProject(request.headers.get('cookie')))
  return target === null ? NextResponse.next() : NextResponse.redirect(new URL(target, request.url), 307)
}

export const config = {
  matcher: ['/', '/task/:path*', '/pr/:path*', '/recipe/:path*', '/landed', '/backlog'],
}
