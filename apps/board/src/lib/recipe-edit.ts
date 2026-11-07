/**
 * What the recipe editor's form holds between submits (#973). Next door to
 * `actions.ts` because a `"use server"` module may only export async functions.
 */
export interface SaveRecipeState {
  ok: boolean
  /** What the file held when the form last read it; the next save is compared against it. */
  loaded: string
  /** What is in the textarea, kept so a refusal does not lose the edit. */
  text: string
  /** The resolver's own words on a refusal, else `saved`. Empty before the first submit. */
  message: string
}
