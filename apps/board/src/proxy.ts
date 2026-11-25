/**
 * A bare `/` is sent to `/?project=<remembered>` (#1435). Every other request
 * passes through. **This file never writes the cookie**: a refresh re-requests
 * a URL that already names its project, and only `rememberProject`, on a
 * person's click, writes the memory.
 */
import { NextResponse, type NextRequest } from 'next/server'

import { homeRedirect, rememberedProject } from './lib/remember.ts'

export function proxy(request: NextRequest) {
  const target = homeRedirect(request.nextUrl.searchParams, rememberedProject(request.headers.get('cookie')))
  return target === null ? NextResponse.next() : NextResponse.redirect(new URL(target, request.url), 307)
}

export const config = { matcher: '/' }
