import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { homeRedirect, projectCookie, rememberedProject } from '../src/lib/remember.ts'

const q = (s: string) => new URLSearchParams(s)

describe('homeRedirect', () => {
  it('sends a bare / to the remembered project', () => {
    expect(homeRedirect(q(''), 'lingtai')).toBe('/p/lingtai/ticket')
  })
  it('leaves / as all projects when the cookie is empty or absent', () => {
    expect(homeRedirect(q(''), '')).toBeNull()
    expect(homeRedirect(q(''), undefined)).toBeNull()
  })
  it('passes through any request that names a project, empty included', () => {
    expect(homeRedirect(q('project=lingtai'), 'other')).toBeNull()
    expect(homeRedirect(q('project='), 'lingtai')).toBeNull()
  })
  it('keeps another parameter and encodes the name', () => {
    expect(homeRedirect(q('a=1'), 'a b')).toBe('/p/a%20b/ticket?a=1')
  })
})

describe('projectCookie', () => {
  it('writes the name, or empty for all projects', () => {
    expect(projectCookie('lingtai')).toBe('lingtai-project=lingtai; Path=/; SameSite=Lax; Max-Age=31536000')
    expect(projectCookie(undefined)).toBe('lingtai-project=; Path=/; SameSite=Lax; Max-Age=31536000')
  })
  it('encodes a name with a space', () => {
    expect(projectCookie('a b')).toContain('lingtai-project=a%20b;')
  })
})

describe('the proxy never writes', () => {
  it('has no cookie write', () => {
    const s = readFileSync(new URL('../src/proxy.ts', import.meta.url), 'utf8')
    expect(s).not.toMatch(/cookies\.set|Set-Cookie/i)
  })
})

describe('rememberedProject', () => {
  it('reads the pair, decoded', () => {
    expect(rememberedProject('x=1; lingtai-project=a%20b; y=2')).toBe('a b')
  })
  it('reads a pair with no = as absent, so the redirect is all projects', () => {
    expect(rememberedProject('lingtai-project')).toBeUndefined()
    expect(homeRedirect(q(''), rememberedProject('lingtai-project'))).toBeNull()
  })
  it('reads an undecodable value as absent', () => {
    expect(rememberedProject('lingtai-project=%E0%A4%A')).toBeUndefined()
  })
})
