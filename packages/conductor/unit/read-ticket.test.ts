/**
 * The one reader of a project's ticket (#731): `db` reads the table and never
 * GitHub, even for a project with an owner; a GitHub project asks GitHub as it
 * always did; a recipe that cannot be read asks nobody.
 */
import type { ProjectState } from '@lingtai/domain'
import { createSqliteTicketSql, openSqliteLog } from '@lingtai/event-store/sqlite'
import { GitHubError } from '@lingtai/github'
import { resolveRecipe } from '@lingtai/recipe'
import { describe, expect, it, vi } from 'vitest'

import { dbTickets } from '../src/db-tickets.ts'
import type { RecipeFor } from '../src/filter.ts'
import { readProjectTicket } from '../src/read-ticket.ts'
import type { Tickets } from '../src/ticket-store.ts'

const state = { project: 'garden', owner: 'someone', base: 'main' } as ProjectState

const recipe = (tickets: string) => `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [], ${tickets} }
env: { required: [], plantAt: .env.local }
steps: {}
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`
const recipeFor =
  (text: string): RecipeFor =>
  () =>
    resolveRecipe(async () => text, 'main')

const neverGitHub = vi.fn(async (): Promise<Tickets> => {
  throw new Error('GitHub was asked')
})

describe('readProjectTicket', () => {
  it('reads a db ticket from the table and never asks GitHub, owner or not', async () => {
    const sql = createSqliteTicketSql(openSqliteLog(':memory:'))
    const opened = await dbTickets(sql, 'garden').createIssue({ title: 'water', body: 'the body', labels: ['bug'] })
    const answer = await readProjectTicket(state, opened.number, {
      recipeFor: recipeFor(recipe('tickets: db')),
      clientFor: neverGitHub,
      tickets: { sql, log: { projectStreams: async () => [] } },
    })
    expect(answer).toMatchObject({ ok: true, from: 'db', ticket: { title: 'water', body: 'the body' } })
    expect(neverGitHub).not.toHaveBeenCalled()
  })

  it('says a db number that is not in the table is missing, from db', async () => {
    const sql = createSqliteTicketSql(openSqliteLog(':memory:'))
    const answer = await readProjectTicket(state, 99, {
      recipeFor: recipeFor(recipe('tickets: db')),
      clientFor: neverGitHub,
      tickets: { sql, log: { projectStreams: async () => [] } },
    })
    expect(answer.ok).toBe(false)
    if (answer.ok) return
    expect(answer.from).toBe('db')
    expect((answer.error as Error).message).toContain('no ticket #99')
    expect(neverGitHub).not.toHaveBeenCalled()
  })

  it('asks GitHub for a github project, passing the number and the signal', async () => {
    const getIssue = vi.fn(async () => ({ number: 7, title: 't', body: 'b', labels: [], url: 'u' }))
    const signal = new AbortController().signal
    const answer = await readProjectTicket(state, 7, {
      signal,
      recipeFor: recipeFor(recipe('')),
      clientFor: async () => ({ getIssue }) as unknown as Tickets,
    })
    expect(answer).toMatchObject({ ok: true, from: 'github', ticket: { title: 't' } })
    expect(getIssue).toHaveBeenCalledWith(7, signal)
  })

  it('hands a GitHub rejection back unchanged, so a 404 survives', async () => {
    const failure = new GitHubError(404, 'GET /x', 'Not Found')
    const answer = await readProjectTicket(state, 7, {
      recipeFor: recipeFor(recipe('')),
      clientFor: async () =>
        ({
          getIssue: async () => {
            throw failure
          },
        }) as unknown as Tickets,
    })
    expect(answer).toEqual({ ok: false, from: 'github', error: failure })
  })

  it('asks nobody when the recipe cannot be read', async () => {
    const broken = new Error('recipe will not parse')
    const answer = await readProjectTicket(state, 1, {
      recipeFor: async () => {
        throw broken
      },
      clientFor: neverGitHub,
    })
    expect(answer).toEqual({ ok: false, from: null, error: broken })
    expect(neverGitHub).not.toHaveBeenCalled()
  })
})
