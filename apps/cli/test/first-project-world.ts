/**
 * A `FirstProjectWorld` written the way the tests wrote it before its IO members became Effects: each member
 * returns a promise. `liftFirstProjectWorld` turns it into the real shape at the one place a test builds a world,
 * so a fake never changes and no expected string moves. Each member is `Effect.tryPromise` with the rejection kept
 * as its own failure — never `Effect.promise`, which would make it a defect (CLI-01's `lift`).
 */
import { Effect } from 'effect'

import type { FirstProjectWorld, GitResult } from '../src/first-project.ts'

type Github = FirstProjectWorld['github']

export interface PromiseFirstProjectWorld extends Omit<
  FirstProjectWorld,
  'git' | 'exists' | 'projects' | 'runtimes' | 'register' | 'history' | 'inFlight' | 'removeMirror' | 'github'
> {
  git: (dir: string, args: readonly string[]) => Promise<GitResult>
  exists: (path: string) => Promise<boolean>
  projects: () => Promise<Effect.Success<ReturnType<FirstProjectWorld['projects']>>>
  runtimes: () => Promise<Effect.Success<ReturnType<FirstProjectWorld['runtimes']>>>
  register: (
    payload: Parameters<FirstProjectWorld['register']>[0],
  ) => Promise<Effect.Success<ReturnType<FirstProjectWorld['register']>>>
  history: (project: string) => Promise<readonly string[]>
  inFlight?: (project: string) => Promise<readonly string[]>
  removeMirror?: (project: string) => Promise<void>
  github: Omit<Github, 'ghStatus' | 'writeAuth' | 'app' | 'boardUrl' | 'waitForApp' | 'picker' | 'add'> & {
    ghStatus: () => Promise<Effect.Success<ReturnType<Github['ghStatus']>>>
    writeAuth: (kind: 'gh' | 'app') => Promise<void>
    app: () => Promise<Effect.Success<ReturnType<Github['app']>>>
    boardUrl: () => Promise<string | null>
    waitForApp: (boardUrl: string) => Promise<Effect.Success<ReturnType<Github['waitForApp']>>>
    picker: () => Promise<Effect.Success<ReturnType<Github['picker']>>>
    add: (...args: Parameters<Github['add']>) => Promise<Effect.Success<ReturnType<Github['add']>>>
  }
}

/** One promise port as an Effect port, for a test that swaps a member after the world is built. */
export const liftPort =
  <Args extends readonly unknown[], A>(f: (...args: Args) => PromiseLike<A>) =>
  (...args: Args): Effect.Effect<A, unknown> =>
    Effect.tryPromise({ try: () => f(...args), catch: (e) => e })

export function liftFirstProjectWorld(w: PromiseFirstProjectWorld): FirstProjectWorld {
  const { inFlight, removeMirror, github, ...rest } = w
  return {
    ...rest,
    git: liftPort(w.git),
    exists: liftPort(w.exists),
    projects: liftPort(w.projects),
    runtimes: liftPort(w.runtimes),
    register: liftPort(w.register),
    history: liftPort(w.history),
    ...(inFlight === undefined ? {} : { inFlight: liftPort(inFlight) }),
    ...(removeMirror === undefined ? {} : { removeMirror: liftPort(removeMirror) }),
    github: {
      ...github,
      ghStatus: liftPort(github.ghStatus),
      writeAuth: liftPort(github.writeAuth),
      app: liftPort(github.app),
      boardUrl: liftPort(github.boardUrl),
      waitForApp: liftPort(github.waitForApp),
      picker: liftPort(github.picker),
      add: liftPort(github.add),
    },
  }
}
