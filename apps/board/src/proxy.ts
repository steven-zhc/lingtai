/**
 * One answer: a bare `/` with a remembered project is answered **307** to that
 * project's home (#1435): the memory changes, so it must never be cached. Every
 * other address, an old one included, passes through (#1501). **This file never
 * writes the cookie**: only `rememberProject`, on a person's click, does.
 */
import { NextResponse, type NextRequest } from 'next/server'

import { homeRedirect, rememberedProject } from './lib/remember.ts'

export function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl
  if (pathname !== '/') return NextResponse.next()
  const target = homeRedirect(searchParams, rememberedProject(request.headers.get('cookie')))
  return target === null ? NextResponse.next() : NextResponse.redirect(new URL(target, request.url), 307)
}

export const config = {
  matcher: ['/'],
}
