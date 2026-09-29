/**
 * The recipe: `~/.lingtai/<project>/recipe.yml`, on this machine, with
 * `runtime.agent` and `runtime.limits` from `~/.lingtai/config.yml`
 * ([0046](../../../doc/decisions/0046-lingtai-is-personal.md) §3, #180).
 * `local.ts` reads it; this file is its schema.
 *
 * **It is not in the managed repository any more.** A `.lingtai/config.yaml`
 * committed there is an ordinary file: nothing reads it to run anything, and
 * editing it changes nothing. Before #180 it was, and the rule that made that
 * safe was 0005's — *read from `origin/<base>`, never from the agent's branch*,
 * with `tamper` catching an edit to it. That rule now holds by location: an
 * agent's blast radius is its worktree, and `~/.lingtai/` is not in it.
 *
 * Nothing sits above this file. The workflow is the recipe's to define, and
 * Lingtai does not second-guess it — what Lingtai owns is *where the file is
 * read from*.
 */
import { z } from "zod";
import { SEVERITIES, Tier, RuntimeId, type Step, isEventType, isRetiredEventType } from "@lingtai/domain";
import { PREFIX } from "@lingtai/env";
import {
  type Plugin,
  type PluginFields,
  type PluginSecrets,
  definePlugin,
  disclose,
  notBuiltYet,
  pluginNaming,
  pluginsNamed,
  readFields,
  servesStep,
} from "./plugin.ts";
import { parseDuration } from "./duration.ts";

/**
 * The names an **extension** may read, declared beside the extension itself
 * ([0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §1).
 *
 * `run:` is the extension point that needs nothing declared — a plugin needs a
 * key, its fields and the steps it serves, and today every declaration lives in
 * `PLUGINS` (0067). Its code is not trusted (0037 §1), and this is where it says
 * which of this machine's credentials it needs. The
 * values are 0021's — `~/.lingtai/env/<project>.env` over the machine's own
 * file — so this file stays a list of names and stays safe to commit, exactly
 * as `env.required` does. **This is 0021's second consumer, not a second
 * mechanism.**
 *
 * **Absent means nothing, not everything.** A command used to be handed the
 * environment the *agent* was given, which is how a Telegram bot token put in
 * one place would reach every extension at once. The declared set is the whole
 * set, and an extension that declares nothing gets only what
 * `runnableEnv` gives any process — `PATH`, `HOME` and the four beside them,
 * which are how a binary is found rather than credentials.
 *
 * **`LINGTAI_*` is refused, and the refusal names the variable.** 0037 §1's
 * reason for distrusting an extension's code is, in as many words, that it
 * "can hang, exit, leak, or read `LINGTAI_DATABASE_URL`" — this system's own
 * log. It is a *prefix* and not a list because `#63` made every name Lingtai
 * reads for itself begin `LINGTAI_`, which is the same reason `isMachineOwn`
 * in `@lingtai/agent-env` is one rule: 0021 deleted `RESERVED` because a
 * denylist is a thing to keep up to date, and a prefix is not.
 *
 * Refused *here*, at the recipe, rather than at the point of use: `lingtai
 * doctor` and `lingtai add` both resolve a recipe without running anything, so
 * a declaration that cannot be honoured is red before a run rather than during
 * one.
 *
 * It costs Lingtai's own recipe nothing, and that is worth writing down because
 * it looks like it should: `LINGTAI_TEST_DATABASE_URL` is what this repository's
 * suite needs, and `pnpm typecheck && pnpm test` reads it from the `.env.local`
 * this run planted in the worktree (`env.plantAt`), not from its environment.
 * A project's own file keeps its own names, so no other repository has a
 * `LINGTAI_` name to declare in the first place.
 */
export const ExtensionEnvNames = z
  .array(z.string())
  .default([])
  .superRefine((names, ctx) => {
    for (const name of names) {
      if (!name.startsWith(PREFIX)) continue;
      ctx.addIssue({
        code: "custom",
        message:
          `"${name}" is one of Lingtai's own names and cannot be declared for an extension — ` +
          `every name Lingtai reads for itself begins "${PREFIX}" (#63), and an extension's code ` +
          "is not trusted with them (0037 §1). A project's own variable keeps its own name.",
      });
    }
  });

/** The outcomes `end` fires on, which is what `close:` and `labels:` filter by. */
const WHEN = z.enum(["landed", "blocked", "failed", "closed", "any"]);

/**
 * A command. Its exit code is the verdict, and `env` is every credential it
 * gets — see `ExtensionEnvNames`. This is the extension point that needs
 * nothing declared: a plugin declares a key, its fields and the steps it
 * serves, and today every declaration lives in `PLUGINS` — 0067 is what lets
 * one come from elsewhere, and it supersedes 0037 §2's *there is no plugin
 * system*. Needing no declaration is also why this is the only one of the
 * thirteen declaring an `env` field at all: `agent`, `watch` and `human` are the
 * core's own and run in the core's own process, so a recipe writing `env:`
 * under one of them is refused by name (0061 §9) rather than having it accepted
 * and ignored.
 */
export const runPlugin = definePlugin("run", {
  fields: {
    run: z.string(),
    timeout: z.string().default("15m"),
    env: ExtensionEnvNames,
  },
  /**
   * **Three steps written out rather than `"*"`, and the reason is `end`.**
   *
   * `"*"` is 0064 §3's second true thing and the shape this plugin wants the
   * day its body moves here: a command at `build` and a command at `proposed`
   * are the same work with the same inputs. What stops it being written today
   * is that `"*"` includes `end`, and `end` runs no pipeline — its consumer is
   * `resolveEndActions`, which carries out three effects and would throw on a
   * command. A cell the schema accepts and the step throws out is `#61` with
   * the throw in a different file, and *accepted ⇒ runs* is the invariant
   * `conductor/unit/step-matrix.test.ts` walks every cell to hold.
   *
   * **`build` is open since 2026-09-27, and it was one key.** Nothing else
   * stood in the way: `runPass` resolves `actionsAt(step, actions)` at all ten
   * and runs them through `runActionPipeline` *before* the body
   * (`conductor/src/pass.ts:1443`), and `pass.ts:166` makes every step but
   * `end` a `"verdicts"` step. `prepared` is the proof rather than the
   * argument — its body is `async () => ({ ending: "passed" })`, character for
   * character what `build`'s is, and a failing `pnpm install` refuses there all
   * the same, because `pass.ts:1460` returns the pipeline's ending and never
   * reaches the body.
   *
   * **`review` is deliberately not opened beside it.** `build` is in
   * `REFUSING_STEPS` and `review` is not — *`review` returns findings and
   * judges nothing* (0058 §3b, `pass.ts:109`) — so a command that fails at
   * `review` has nowhere to put the failure until `proposed` has a judge to
   * read it. That judge is `judgePlugin.at.proposed`, open since `#274`, which
   * is where the rest of [T5d](../../../doc/design/the-pipeline.md) went.
   */
  at: {
    prepared: notBuiltYet,
    build: notBuiltYet,
    proposed: notBuiltYet,
    merge: notBuiltYet,
  },
});

/**
 * A cold reviewer, given the diff: **which runtime runs it**, optionally which
 * model, and the prompt it is handed
 * ([0063](../../../doc/decisions/0063-every-setting-is-the-recipes.md) §2).
 *
 * `agent:` carried the prompt until `#245`. It is the runtime now, because
 * [0053](../../../doc/decisions/0053-the-recipe-chooses-the-agent-for-each-role.md)
 * has said since 2026-09-17 that *which* CLI does a project's work is the
 * recipe's decision and not the machine's — and a prompt kept in one file with
 * its runtime in another splits one decision across two sources. `model:` and
 * `prompt:` sit beside the key rather than under it, so the scalar stays a
 * single value (0063 §2).
 *
 * **The enum is the whole safety of that reinterpretation, not a style
 * choice.** A `z.string()` here would take the paragraph of prose a file
 * written before `#245` puts under `agent:`, parse it cleanly, and hand it on
 * as the *name of a runtime* — failing at spawn, in a worktree, a long way from
 * the line that is wrong. `z.enum` refuses it where it is written, by name, at
 * resolve: that is 0016 §4, and it is the shape
 * [#230](https://github.com/steven-zhc/lingtai/issues/230) hit when a leftover
 * a retired key was dropped by a `z.object` with the suite green.
 *
 * `model` is optional, and **absent means the runtime's own default** — which
 * is a thing a reader can be shown rather than a blank. Lingtai does not carry
 * a table of each runtime's default here: naming one would be a second place
 * for it to be wrong, and the runtime already knows. Present, it is carried by
 * `actionsFromRecipe` onto `AgentActionSpec` and by `createAgentAction` onto
 * `RunRequest.model`, so the key changes what is spawned rather than only what
 * is hashed.
 *
 * **This schema says which runtime, and no step dispatches a second one yet.**
 * One conductor runs one runtime and hands it to every gate, so a value here
 * that is not the dispatched one cannot be honoured — and is refused before the
 * claim by `agentRefusal` (`conductor/src/conduct.ts`), which reads every
 * `agent:` in the file rather than `runtime.agent` alone. The enum is what a
 * *name* has to be in; the refusal is what makes the name true of the run.
 */
export const agentPlugin = definePlugin("agent", {
  fields: {
    agent: RuntimeId,
    model: z.string().optional(),
    prompt: z.string(),
  },
  /** Not `prepared`: nothing has been committed there, so there is no diff to read. */
  /**
   * **`design` since `#265`, and it is the one key here that is not a reviewer.**
   *
   * Nothing has been committed at `design` either, which is `prepared`'s reason
   * for being absent — and it is not this step's, because what an `agent:` does
   * here is *write* the thing rather than read one: a document before any code
   * (0058 §3), or nothing, which is an answer. So the same key builds a different
   * action, `createDraftAction`, and `actionsFromRecipe` is where the step picks;
   * a `design:` built out of the reviewer would return `passed` on the empty diff
   * without dispatching anything, which is the `#61` shape 0065 §5 removes.
   *
   * **The default at this step is still nothing**, and that is the whole of what
   * *nothing depends on `design` today* means: `conduct.ts`'s `defaultsAt` has no
   * row for it, an unconfigured `design` runs no action and its body passes, and
   * `implement` is briefed with `""` and works from the issue — every pass, as
   * every pass already did. This key is new capability rather than a swap, which
   * is why it is the only one of 0065 §4's openings that can be read without
   * re-reading a recipe first.
   */
  /**
   * **`review` since 2026-09-27, and `pass.ts` was already written for it.**
   * `pass.ts:1589` reads `if (spec.step === "review") return { ending:
   * "passed" }` — a reviewer's `failed` is its findings and not a verdict about
   * the step (0058 §3b), so they ride out on `results` and `proposed` reads them
   * to decide there is a `findings` direction to judge at all. Declaring the
   * cold reviewer here rather than at `proposed` is what makes that arrival a
   * *routing* arrival instead of `proposed` refusing on its own behalf.
   *
   * `merge` stays for the re-verify after a moved base. `build` is not here: a
   * `run:` belongs there, and an agent asked to build would be paid to read.
   */
  /**
   * **`implement` since `#266`, and it is the key that closes 0065 §1's
   * asymmetry.**
   *
   * The cold reviewer has been an `agent:` a person can read and edit since this
   * schema existed; the agent that *writes the code* was `runtime.agent` in
   * `~/.lingtai/config.yml`, reached through a port, with no line in any recipe
   * naming it. Both are here now, and a recipe that declares nothing at
   * `implement` gets `conduct.ts`'s `defaultsAt` row — which reads
   * `runtime.agent`, so nothing changes for a file nobody edited.
   *
   * **A third action off this one key** (`from-recipe.ts`), for the reason
   * `design` is a second: the reviewer opens by asking for the diff and returns
   * `passed` when there is none, and at `implement` there is none *yet* — the
   * diff is what this step produces. So the same block builds `createWorkAction`,
   * which is handed the dispatch rather than a runtime and a diff.
   */
  at: {
    design: notBuiltYet,
    implement: notBuiltYet,
    review: notBuiltYet,
    proposed: notBuiltYet,
    merge: notBuiltYet,
  },
});

/**
 * **Why a path is not inside the worktree, or `null` when it is** — the whole of
 * what `file:` refuses about its own field
 * ([0066](../../../doc/decisions/0066-a-large-answer-is-a-locator-on-the-log.md) §6).
 *
 * A string and not `node:path`, because the answer has to be the same wherever
 * the recipe is read: `lingtai add` resolves on the operator's machine and the
 * daemon resolves on its own, and `path.isAbsolute` answers differently on
 * Windows. What is legal is a relative path with no `..` in it, which is the
 * same rule `git` itself applies to a pathspec.
 *
 * **Refused where it is written and never checked again**, which is 0066 §6's
 * *before a worktree, before an agent, before any money*: a `..` caught at run
 * time is one claim, one clone and one paid agent, and then a person answering a
 * refusal a schema line could have printed (§6's correction, `#299`).
 */
export function whyThePathEscapes(written: string): string | null {
  if (written === "") return "it is empty, and a document has to be written somewhere";
  if (/^[\\/]/.test(written) || /^[A-Za-z]:[\\/]/.test(written)) {
    return "it is absolute, and an absolute path names somewhere outside the tree this pass owns";
  }
  if (written.startsWith("~")) {
    return "it starts at a home directory, which is where Lingtai's own files live and is not the worktree";
  }
  const segments = written.split(/[\\/]/);
  if (segments.includes("..")) {
    return 'it contains a ".." segment, so where it lands depends on where the worktree is rather than on what is written here';
  }
  if (segments.some((segment) => segment === "")) {
    return "it has an empty segment, so it names a directory rather than a file to write";
  }
  return null;
}

/**
 * **Keeps what an earlier action at the step made, as a file in the worktree** —
 * the first destination 0066 §5 asks for, and the whole of what makes a design
 * survive the pass that bought it.
 *
 * A design was *bought, used once and could not be kept*
 * ([0066](../../../doc/decisions/0066-a-large-answer-is-a-locator-on-the-log.md)
 * §1): the document lived on `WroteTheDesign.design` until the pass ended, in
 * `implement`'s prompt for one dispatch, and on `StepPassed.evidence` uncapped.
 * This writes it to a path and returns that path as the **locator** — a string,
 * and nothing above this plugin reads it (§4,
 * [0069](../../../doc/decisions/0069-both-the-document-and-the-locator-cross-the-step-boundary.md)
 * §3). `createFileAction` in `packages/actions/src/file-action.ts` is the work.
 *
 * ## `commit:` is required and has no default, and that is the decision
 *
 * 0066's *What this does not decide* leaves it here and asks for a sentence, and
 * the sentence is that **both answers are real and neither is safe to assume**.
 *
 * Committed, the note rides the branch through `build` and `review` and the lane
 * merges it — which for a repository's own design document is the point, and for
 * a one-ticket brief is noise in every diff. **Uncommitted, it does not survive
 * the pass**: the worktree is removed by `runOnce`'s finalizer, so the file and
 * the path that locates it are both gone before anybody can follow either, which
 * is §1's failure with a new spelling rather than a fix for it.
 *
 * So there is no default, for `worktree.submodules`'s reason (`#268`): a value
 * nobody wrote would be a behaviour nobody chose, and a recipe that does not say
 * is refused by name. It is **not** a safety question — `#265`'s receipt is
 * `head === startedAt`, so a design commit cannot stand in for work the
 * implementer did not do — it is a question about what belongs in the change.
 *
 * ## It keeps what the step made and never what it was handed
 *
 * The document comes from an earlier action in **this step's own list**, which
 * `runActionPipeline` hands forward (`ActionContext.design`). So a `file:` is
 * written after the action that drafts, and one written first is refused when the
 * recipe resolves — there is nothing before it to have made anything, and an
 * action that quietly kept nothing would be `#61` wearing a destination's name.
 */
export const filePlugin = definePlugin("file", {
  fields: {
    /** Where the document goes, relative to the worktree. `whyThePathEscapes` is the rule. */
    file: z.string().superRefine((written, ctx) => {
      const why = whyThePathEscapes(written);
      if (why !== null) {
        ctx.addIssue({
          code: "custom",
          message:
            `"${written}" is not a path inside the worktree — ${why}. A \`file:\` writes into the tree ` +
            "this pass owns and nowhere else, so the path is relative to it, with no `..` in it",
        });
      }
    }),
    /**
     * Whether the file is part of the change. **Required and undefaulted** — the
     * paragraph above is why, and it is the one field on this plugin whose two
     * values are two different products.
     */
    commit: z.boolean(),
  },
  /**
   * **`design`, and it is the only step that makes something large today**
   * (0066 §3).
   *
   * What crosses the boundary is `TheDesign` — the document and the locator
   * beside it (0069 §2) — and this is the plugin that puts the second of those
   * two on it. A second step that bought a document would declare this key
   * beside its own drafter and nothing here would change, which is the test 0066
   * §9 sets for whether §4 held.
   */
  at: { design: notBuiltYet },
});

/** Globs against the diff's file list; a match holds or fails. */
export const watchPlugin = definePlugin("watch", {
  fields: {
    watch: z.array(z.string()).min(1),
    then: z.enum(["request-approval", "fail"]).default("request-approval"),
  },
  /**
   * Not `prepared`: the globs would be matched against no file list.
   *
   * **And not `merge` since `#270`**, for the reason `humanPlugin` loses it:
   * `then: request-approval` is the default, so a watch is a way of reaching a
   * person, and 0058 §3b's three ways out of `merge` end *anything else →
   * `proposed`, and only `proposed` may send it to a person*. A glob over the
   * diff's file list is a question about a change already built, which is the
   * step `whyThatPair` sends every other misplaced `watch:` to.
   */
  at: { proposed: notBuiltYet },
});

/** Waits for a person. The string is the question they are asked. */
export const humanPlugin = definePlugin("human", {
  fields: { human: z.string() },
  /**
   * Not `prepared`: a hold there is a release, so the question re-asks itself
   * every pass.
   *
   * **And not `merge` since `#270`, which is a subtraction 0058 asked for and
   * `mergePlugin`'s own key is what made urgent.** While the landing happened in
   * `merge`'s *body*, after the whole pipeline, an approval declared here held it:
   * that is `#58`'s fix and CLAUDE.md described it. Since the lane is an action in
   * the same list, an approval written after it would be run after it — the
   * pipeline merging the branch and then asking a person whether to, which is
   * `#58` again with the order reversed. `ONLY_PROPOSED_ASKS_A_PERSON` is the
   * refusal, and it is the rule rather than the workaround: 0058 §3b gives `merge`
   * three ways out and **only `proposed` may send it to a person**, so the step
   * where a proposed change is inspected is `proposed` — which is where that ADR's
   * own open question already puts the `human:` approval and the `watch:`.
   *
   * The injected holds are untouched and are not this key's business:
   * `alsoHeldAtMerge` in `conduct.ts` puts a `human:` at `merge` for a pending
   * repair and for `--no-merge`, built by `createHumanAction` rather than read off
   * a recipe. Those are the caller's, they compose ahead of the lane
   * (`heldBeforeTheLane`), and `whyNoKindAt` never sees them.
   */
  at: { proposed: notBuiltYet },
});

/**
 * Closes the issue. Only meaningful at `end`, which is the one point that
 * cannot refuse — these run for effect.
 *
 * `when` filters on the outcome, because `end` fires on *every* terminal
 * state. "Close it when it lands, label it when it is blocked" is then one
 * configuration rather than two mechanisms.
 *
 * `closed` is the fourth, and `any` includes it (0044): a ticket a person
 * ended is a ticket whose issue this action is the right way to close. It is
 * also the pairing that removes a manual step — `lingtai close` used to
 * append a terminal and leave the GitHub issue open, so somebody still had
 * to run `gh issue close` by hand afterwards.
 */
export const closePlugin = definePlugin("close", {
  fields: {
    close: z.literal(true),
    when: WHEN.default("landed"),
  },
  /** An effect, and `end` is the one step that carries out effects. */
  at: { end: notBuiltYet },
});

/** Sets labels. Lingtai's own are replaced; everybody else's are kept. */
export const labelsPlugin = definePlugin("labels", {
  fields: {
    labels: z.array(z.string()),
    when: WHEN.default("any"),
  },
  at: { end: notBuiltYet },
});

/**
 * **Deletes the history refs a landed ticket left on `origin`** — the
 * `agent/<n>-attempt-<k>` siblings `armBranch` pushes
 * ([0062](../../../doc/decisions/0062-what-a-claim-leaves-behind.md) §2), one
 * per approach the item tried.
 *
 * Nothing else deletes a branch, so the count is monotone in how many issues a
 * repository has had: this one carried **150 `agent/*` refs**, thirteen of them
 * abandoned arms, and every clone, `ls-remote` and fetch pays for all of them.
 * An effect, like `close:` and `labels:` beside it, so `end` is the only point
 * that carries it out and it cannot refuse.
 *
 * **It is declinable by not being declared, and that is the whole reason it is
 * a plugin** (0061 §2). A team that keeps every branch for audit says so by
 * leaving this out; a pass that deleted refs on its own would give them no way
 * to say no.
 *
 * ## `when:` is `landed` and the schema admits no other value
 *
 * **This is the safety argument, not a default somebody may override.** For an
 * item that did *not* land, those refs are the only surviving account of what
 * was tried — `#239` exists to create them precisely so a later attempt can
 * fetch them, and `attemptBrief` tells the next agent to. A cleanup on any
 * other ending destroys the thing the ticket before it was written to preserve,
 * and a value nobody can write is a mistake nobody can make. So this is a
 * `z.literal` where the other two effects carry `WHEN`: `when: any` here is
 * refused by name when the recipe resolves, which is the same argument
 * `agent:`'s enum makes one plugin up — *the enum is what makes a destructive
 * reading safe*. It is written rather than inferred because the file should say
 * out loud which ending it is cleaning up after.
 *
 * `branch:` is the one thing left to decide, and it is **`false`**. After a
 * merge `agent/<n>`'s commits are reachable from `main`, so deleting it loses
 * no history — but it is the ref a person follows from the merge commit, and
 * the default a cleanup ships with should be the one that keeps what somebody
 * might read. `branch: true` takes it too.
 */
export const refsPlugin = definePlugin("refs", {
  fields: {
    /** `true` and nothing else: what it deletes is decided by `branch:`, not by a value here. */
    refs: z.literal(true),
    /** `agent/<n>` itself, on top of its arms. Off, so the merge commit's ref still resolves. */
    branch: z.boolean().default(false),
    /** `landed`, and only `landed` — see above. Written out, so the file says which ending. */
    when: z.literal("landed").default("landed"),
  },
  at: { end: notBuiltYet },
});

/**
 * **The branch a pass owns, cut** — a name for `provisionWorktree` in
 * `packages/repo/src/worktree.ts`, which is what has always done this
 * ([0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §3).
 *
 * A map rather than a scalar, which is 0061 §2's rule — *a scalar where one
 * reads well and a map where it does not* — applied to a plugin that carries
 * two settings and no obvious principal one. It is also the shape
 * [`the-v2-recipe.md`](../../../doc/design/the-v2-recipe.md) §1 writes, and
 * that file is the target T3 is checked against.
 *
 * **`base` is written here, and `repo.base` is the same setting's v1
 * spelling** (`#268`). This is the home 0061 §4 gives it; `baseOf` in
 * [`settings.ts`](settings.ts) is the one place that knows a file may still
 * write the other, and every reader — the merge lane, `lingtai doctor`,
 * `lingtai add`, the board, the wizard — asks that one question. So the two are
 * not two homes for one setting, and a declaration here cannot disagree with
 * what the merge lane lands on: the lane goes on being *handed* the base rather
 * than declaring one of its own (§4).
 *
 * **`submodules` is required and is not defaulted**, which is the one way this
 * declaration differs from the `repo:` block it replaces. `git worktree add`
 * leaves submodule directories empty, and the tests that import one then fail in
 * a way that reads as the agent's fault — so a `worktree:` that named only its
 * base and took `false` from a schema would be that failure arriving *because*
 * somebody configured the step, with `repo.submodules: true` sitting unread two
 * blocks up. A recipe that does not say is refused by name instead (`#268`).
 */
export const worktreePlugin = definePlugin("worktree", {
  fields: {
    worktree: z.strictObject({
      /** The branch the agent's work is cut from and lands on. `origin/<base>`, never local state. */
      base: z.string(),
      /** Whether the tree gets them. Written out on purpose — see above. */
      submodules: z.boolean(),
    }),
  },
  /**
   * **`admit`, and it is the first of 0061 §3's five names to become a key**
   * ([0065](../../../doc/decisions/0065-the-default-is-a-plugin.md) §4, `#268`).
   *
   * What runs is `createWorktreeAction` in `@lingtai/actions`, over the cut
   * `conduct.ts` hands it — and a recipe that declares nothing at `admit` runs
   * the same action off `baseOf`/`submodulesOf`, because 0065 §2 makes the
   * default an entry in the plugin system rather than a body beside it. So
   * `CALLED_DIRECTLY.worktree` is gone with this key, in the one diff its own
   * comment asked for.
   */
  at: { admit: notBuiltYet },
});

/**
 * **The same branch, landed** — a name for the integrator,
 * `packages/repo/src/integrate.ts`: the base in, verify, the base out.
 *
 * **It declares no `base:`, and that is deliberate rather than an omission**
 * (0061 §4). `base` is one value that flows: `worktree.ts:133` and
 * `integrate.ts:73` both take it as a parameter and exactly one place writes
 * it. Giving this plugin one of its own would manufacture a disagreement
 * between what a pass cut and what it lands — a failure that cannot happen
 * today and that no amount of checking would be as good as not having.
 *
 * `strategy` has one legal value because `integrate.ts` offers one: `git merge
 * --no-edit` of the branch into the base, then a push that is a fast-forward
 * where it can be one. A second value here would be a behaviour this repository
 * does not have, declared as though it did — `#61` one level down — so the
 * enum says what the code does and grows when the code does.
 */
export const mergePlugin = definePlugin("merge", {
  fields: {
    merge: z.strictObject({
      strategy: z.enum(["merge-commit"]).default("merge-commit"),
    }),
  },
  /**
   * **`merge`, and it is the second of 0061 §3's five names to become a key**
   * ([0065](../../../doc/decisions/0065-the-default-is-a-plugin.md) §2, `#270`).
   *
   * What runs is `createMergeAction` in `@lingtai/actions`, over the lane
   * `conduct.ts` hands it — and a recipe that declares nothing at `merge` runs
   * the same action off the same base, because 0065 §2 makes the default an
   * entry in the plugin system rather than a body beside it. So
   * `CALLED_DIRECTLY.merge` is gone with this key, in the one diff its own
   * comment asked for.
   *
   * **It reports and it does not decide.** A refused merge carries the lane's own
   * `reason` and `detail` and goes to `proposed`, which is where a `conflict` is
   * weighed and where a `verify-failed` buys the mechanical round — so opening
   * this key moves where the lane is *called from* and nothing about what its
   * answer costs.
   */
  at: { merge: notBuiltYet },
});

/**
 * **The three of `queue:`'s four fields whose v1 spelling is `source:`** —
 * written here once, and read by two shapes: `source:` in the v1 file, and
 * `QUEUE_FIELDS` below, which adds the fourth.
 *
 * A plain record of schemas rather than a `z.object`, because the two shapes
 * differ in one way that matters and in no other: `source:` is a `z.object`,
 * which is what it has always been, and a plugin's fields go through
 * `z.strictObject` because the contract makes every plugin strict (0061 §9).
 * Sharing the *fields* rather than the object keeps both true without either
 * borrowing the other's strictness.
 *
 * **Not a migration and not a second home.** `queue:` serves `claim` since
 * `#269`, so there are two places a person can write these and they are one
 * setting each: `settings.ts` is what knows which spelling a file used, exactly
 * as it does for the base. What this sharing removes is the copy that would
 * otherwise exist: a `kinds` the plugin required and `source:` did not would be
 * two answers to *what is a kind*, and the one list doing three jobs below is
 * the reason that must not happen twice.
 *
 * **What is shared is the field and not its default**, and that is the one way
 * the two shapes differ in substance (`#269`). `source:` defaults `exclude` to
 * `[]` and `backoff` to `1h`, because a v1 file that says neither has always
 * meant those; a `queue:` block must **name all four**, for `submodules`'
 * reason one plugin up — a block that named only its kinds would replace the
 * hold list with `[]` and the backoff with `1h` while `source:` sat two blocks
 * up unread, which is a held ticket claimed and an agent dispatched on work a
 * person was holding. So the schemas below are declared without their defaults
 * and `SOURCE_FIELDS` adds them; `QUEUE_FIELDS` takes them bare.
 *
 * **`assignee` is not here, and that is the same rule kept rather than broken**
 * ([0063](../../../doc/decisions/0063-every-setting-is-the-recipes.md) §3). It
 * is a field of `queue:`, and its v1 spelling is `runtime.assignee` on the
 * machine's own file — not `source.assignee`, which no file has ever held.
 * Putting it in `source:` too would invent a third spelling that nothing reads,
 * which is the silently-dropped key 0016 §4 is about.
 */
/**
 * Labels of yours that mark an issue as work, **most wanted first**.
 *
 * One list doing three jobs, and that is the design rather than an
 * economy: it is the vocabulary (a label outside it is not a kind at all),
 * the filter (`kindOf` matches against exactly this), and the priority
 * order (earlier wins).
 *
 * Free-form since #76, and `exclude` always was. There used to be a
 * `WorkKind` enum in the core — `bug` · `feature` · `enhancement` ·
 * `tech-debt` — and a recipe naming any other label failed to resolve,
 * which took *every* issue in the project down with it rather than the one
 * label. It also contained `enhancement`, which no recipe had ever used,
 * and omitted `documentation`, which one wanted. Which of a repository's
 * labels name work is a fact that repository has and this schema does not,
 * which is 0016 §7 exactly.
 *
 * **Required in both shapes**, and the only one of the three that always was: a
 * recipe that names no kind takes nothing at all.
 */
const KINDS = z.array(z.string()).min(1);

/**
 * Labels of yours that must keep the agent off a ticket, matched
 * case-insensitively by whole name.
 *
 * **This is the only reason an issue is passed over for its labels.** There
 * was a rule in `discover.ts` too, skipping anything labelled `agent:*` as
 * belonging to another system; it is gone. A namespace is not a meaning —
 * `agent:hold` and `agent:followup` share a prefix and mean opposite
 * things — and which of a repository's labels are holds is a fact that
 * repository has and this schema does not.
 *
 * Whole names rather than patterns, deliberately: `agent:*` would have to
 * be spelled with an exception for the one label in it that means "ready",
 * and an exclude list with negation in it is a small language. List them.
 *
 * **Declared without its default**, which `SOURCE_FIELDS` adds and
 * `QUEUE_FIELDS` does not: a `queue:` block that named only its kinds would
 * take `[]` here and drop the hold list, which is an `agent:hold` ticket
 * claimed and an agent dispatched on work a person was holding.
 */
const EXCLUDE = z.array(z.string());

/**
 * How long a failed attempt keeps its own ticket out of the queue
 * ([0028](../../../doc/decisions/0028-the-backoff-is-the-recipes.md)).
 *
 * A failed run releases its task, a release is a completion event, and a
 * completion event is what tells the conductor to look again — so without
 * this the top of the queue is the ticket that just failed, forever, at
 * agent prices. The old harness re-ran #58 and #59 five times for roughly
 * $29 exactly that way.
 *
 * Here rather than compiled into Lingtai for the reason `repair` is: how
 * long a failure of *this* repository's is worth waiting out depends on
 * what its failures usually are, and that is a thing the repository knows
 * and the core cannot see (0016 §7). One hour by default under `source:`,
 * flat — the wait does not grow with attempts, because what changes between
 * attempts is what the next one is told (#82) and not how long it sat.
 *
 * A duration like `runtime.limits.wall`, and it must be a positive one:
 * zero is not a shorter backoff, it is the absence of the guard, and the
 * thing a person wants when they reach for it is `lingtai now`.
 *
 * **Declared without its default, for `EXCLUDE`'s reason**: an hour silently
 * replacing a configured `45m` is quieter than the hold list and no more
 * correct.
 */
const BACKOFF = z
  .string()
  // Checked here rather than left to throw at the point of use: a recipe
  // that will not resolve names the key it failed on, and an exception out
  // of the middle of a queue pass names nothing.
  .refine((text) => positiveDuration(text), { message: "must be a positive duration, like 1h" });

const SOURCE_FIELDS = {
  /**
   * Labels of yours that mark an issue as work, **most wanted first** — `KINDS`.
   */
  kinds: KINDS,
  /** The labels that keep the agent off a ticket — `EXCLUDE`, and none is none. */
  exclude: EXCLUDE.default([]),
  /**
   * How long a failed attempt keeps its own ticket out of the queue — `BACKOFF`,
   * and an hour where a v1 file says nothing, which is what it has always meant.
   */
  backoff: BACKOFF.default("1h"),
} satisfies PluginFields;

/**
 * `mine`: only issues assigned to `login`. `unassigned`: only issues assigned
 * to nobody. `both`: every issue, whoever it is assigned to — today's queue.
 */
export const AssigneeTake = z.enum(["mine", "unassigned", "both"]);
export type AssigneeTake = z.infer<typeof AssigneeTake>;

/**
 * The machine's GitHub login and what it takes by assignee.
 *
 * The login is not proof of anything, and does not need to be: a wrong one
 * hands this machine somebody else's tickets on the next pass, which is a
 * mistake that shows itself (0046 §2).
 */
export const AssigneeRule = z
  .strictObject({
    login: z.string().min(1).optional(),
    take: AssigneeTake.default("both"),
  })
  // `mine` with nobody named would match no issue at all, and an empty queue
  // reads exactly like a repository with nothing to do.
  .refine((rule) => rule.take !== "mine" || rule.login !== undefined, {
    message: "take: mine needs a login — the GitHub login this machine's issues are assigned to",
    path: ["login"],
  });
export type AssigneeRule = z.infer<typeof AssigneeRule>;

/**
 * **`queue:`'s four fields**: `source:`'s three, and `assignee` beside them
 * ([0063](../../../doc/decisions/0063-every-setting-is-the-recipes.md) §3).
 *
 * `assignee` used to be a plugin of its own, and 0061 §§2–3 used the pair as
 * the worked example of *a step's plugins run in the order written*. 0063 §3
 * revises that: **they answer one question.** `kinds` orders the listing,
 * `exclude` filters it, `assignee` filters it, and all four are applied in one
 * pass over one GitHub response in `discover.ts`. Two plugins that must both
 * be present and must agree is 0053's *one decision across two sources*, one
 * level down.
 *
 * **`AssigneeRule` itself, and not a copy of it**, so its one refinement stays
 * one refusal: `take: mine` without a `login` matches no issue at all, and an
 * empty queue reads exactly like a repository with nothing to do. That is why
 * the rule is a `strictObject` with a `.refine` rather than two loose fields,
 * and it goes on firing from in here.
 *
 * **All four are required, and none of them defaults** — which is the one way
 * this differs from the `source:` shape it shares its fields with, and it is
 * `submodules`' rule on `worktree:` kept rather than restated (`#268`, `#269`).
 * A block is *the four values this step selects on*, so a person who writes one
 * to narrow the kinds cannot silently lose the hold list to a `[]`, the backoff
 * to an hour, or `runtime.assignee` to `both`: the three that would have been
 * quiet are refused by name instead, and the refusal names the key to add.
 * `assignee: { take: both }` is how a machine with nobody named writes what an
 * absent `runtime.assignee` has always meant — spelled out, because the whole
 * failure this step can have is being quietly wrong about which ticket it took.
 */
const QUEUE_FIELDS = {
  kinds: KINDS,
  exclude: EXCLUDE,
  backoff: BACKOFF,
  assignee: AssigneeRule,
} satisfies PluginFields;

/**
 * **The four values, as one object** — what a `queue:` block is, and what the
 * code that picks a ticket is handed (`#269`).
 *
 * Named rather than left inline because two things now read the same shape and
 * neither may drift from the other: the plugin's own field below, and
 * `queueOf(recipe)` in [`settings.ts`](settings.ts), which is how every reader
 * that has only a recipe gets one. `considerIssue` and `runnableNow` in
 * `packages/conductor/src/discover.ts` take *this* rather than a whole recipe,
 * so a `queue:` declared at `claim` and the `source:`/`runtime:` spelling reach
 * the selection down one path instead of two.
 */
export const QueueSettings = z.strictObject(QUEUE_FIELDS);
export type QueueSettings = z.infer<typeof QueueSettings>;

/**
 * **Which ticket is taken, and whether this machine may take it** — a name for
 * `runnableNow`, `considerIssue` and `assigneeSkip` in
 * `packages/conductor/src/discover.ts`, which is what has always decided this
 * ([0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §3,
 * [0063](../../../doc/decisions/0063-every-setting-is-the-recipes.md) §3), and
 * for what `claimWorkItem` in `packages/conductor/src/claim.ts` then does with
 * the one that survives.
 *
 * A map, by §2's rule — four settings and no principal one — and three of them
 * are `source:`'s own fields, shared rather than copied: `SOURCE_FIELDS` above
 * is the single declaration both read.
 *
 * **What it does *not* declare is the more useful half.**
 *
 * - **No `blocked-by` field, because it is not a setting.** The queue passes
 *   over an issue GitHub still reports an open blocker for, always, and there
 *   is no recipe that turns that off (`discover.ts:174`). Two facts about it
 *   are load-bearing and neither is configuration: `blockedBy` counts the
 *   blockers still **open**, not the total, so a chain whose groundwork has
 *   landed reads `total_blocked_by: 2, blocked_by: 0` and runs; and **null is
 *   not zero** — a GitHub that says nothing about dependencies degrades to the
 *   behaviour from before this existed rather than passing everything over,
 *   which is what `Offered.dependenciesUnread` says out loud.
 * - **No `restarts`.** It is a universal key sitting beside this plugin rather
 *   than a field of it (0061 §2 and §3): *this item may be claimed twice* is
 *   the workflow's bound on the step, and `runtime.limits.restarts` is where a
 *   person writes it today.
 * - **No `env:`.** Nothing here spawns a process — the queue runs in the
 *   conductor's own process — so a recipe writing one is refused by name
 *   (0061 §9) rather than having it accepted and ignored.
 */
export const queuePlugin = definePlugin("queue", {
  fields: { queue: QueueSettings },
  /**
   * **`claim`, and it is the last of 0061 §3's five names to become a key**
   * ([0065](../../../doc/decisions/0065-the-default-is-a-plugin.md) §2, `#269`).
   *
   * What runs is `createQueueAction` in `@lingtai/actions`, over the four values
   * the action carries — and a recipe that declares nothing at `claim` runs the
   * same action off `queueOf(recipe)`, because 0065 §2 makes the default an entry
   * in the plugin system rather than a body beside it. So `CALLED_DIRECTLY.queue`
   * is gone with this key, in the one diff its own comment asked for.
   *
   * **It cannot refuse, and that is the pipeline's rule rather than this
   * plugin's** (0058 §2). A refusal buys a fix round, holds the work item and
   * reaches a person, and a `claim` that took nothing is holding nothing: so the
   * three declines are `failed` verdicts at a step `REFUSING_STEPS` does not
   * carry, which `endingOf` reports as `did-not-finish` carrying the action's own
   * `because` — `passed-over`, `not-claimed`, `claim-unconfirmed`.
   *
   * **One take per step, and the reduction 0061 §2 promised here is not what
   * happens.** `FIRST_YIELDS` used to say a `claim` list would take the first
   * plugin that yielded an item; the pipeline stops at the first action that did
   * *not* pass, so two `queue:` entries would be *both must agree* and not *first
   * wins*. `StepMap` refuses the second by name rather than resolving a list
   * whose order reads as a priority it does not have.
   *
   * **What is still called directly is the queue pass**, and it is a different
   * question rather than the same one twice: `selectRunnable` in
   * `packages/conductor/src/queue.ts` asks GitHub which issues are on offer
   * *before a pass exists to have steps*, and `source.backoff` is only read
   * there. This key is the pass's own re-read of that answer for the one issue it
   * was pointed at — which is why a label edited between the two takes effect,
   * and why `backoff` rides on the block without being read at `claim` (0063 §3:
   * the four answer one question, and the block is the unit).
   */
  at: { claim: notBuiltYet },
});

/**
 * **The five reasons a pass arrives at `proposed`**, which is what a `judge:`
 * entry's `when:` names — and there is **one entry per reason**
 * ([0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §3).
 *
 * **`when:` is one key and its legal values are the step's**, which is
 * [0059](../../../doc/decisions/0059-a-point-carries-only-the-kinds-it-runs.md)'s
 * rule a third time: `close:` and `labels:` read the work item's *outcome* at
 * `end` (`WHEN` above — `landed`, `blocked`, `failed`, `closed`, `any`),
 * `refs:` reads the one value of that vocabulary it is safe to delete on, and a
 * judge reads **the reason the last step gave**. Two steps, two vocabularies,
 * and a value one of them does not know is refused by name when the recipe
 * resolves.
 *
 * Two of the five are the merge lane's own words and mean there what they mean
 * here: `conflict` and `verify-failed` are `RefusalReason` in
 * `packages/domain/src/events.ts`. The other three are the reasons the steps
 * 0058 §3 named will report when they are built (0061 §5) — `red` is `build`'s,
 * `findings` is `review`'s, and `needs-input` is an implementing agent that
 * stopped to ask, which is 0057's class rather than a refusal.
 *
 * **Not `RefusalReason` itself**, though it holds two of the five. That enum is
 * the *integration*'s list — `dirty-base`, `unpushed-base`, `push-rejected` —
 * and a judge is never asked about those: they stop the lane before the diff is
 * what is in doubt, and offering a judge a direction nothing can arrive by is
 * the same mistake as offering it a step nothing can run.
 */
export const JudgeWhen = z.enum(["red", "verify-failed", "conflict", "needs-input", "findings"]);
export type JudgeWhen = z.infer<typeof JudgeWhen>;

/**
 * **The judges that spend nothing**, and the list is shorter than 0061 §3's
 * example on purpose.
 *
 * `same-worktree` is the mechanical answer — *back to `implement` with the
 * error* — and it is a function in `packages/conductor/src/judge.ts`. A
 * **synchronous** one, which is what makes *spends no agent* a fact about its
 * type rather than a promise in prose: nothing that dispatches an agent can
 * answer without awaiting.
 *
 * 0061 §3's yaml also names `ask-or-assume` for `needs-input`, and it is **not
 * here, because nothing implements it**. A name the schema accepts and no code
 * answers is `#61` arriving through the one door this repository has decided it
 * will not leave open — the same rule that gives `merge:` one `strategy`: the
 * enum says what the code does, and grows when the code does.
 */
export const BUILT_IN_JUDGES = ["same-worktree"] as const;
export type BuiltInJudge = (typeof BUILT_IN_JUDGES)[number];

/**
 * Who decides a direction — **the built-ins, and the runtimes beside them**
 * (`#277`).
 *
 * It was this list while the plugin served no step, where the wider enum cost
 * nothing because every cell was refused; `#274` opened `at.proposed` and took the
 * runtimes out, on the one rule that governs both lists — *the enum says what the
 * code does, and grows when the code does* — because a `judge: claude-code` would
 * have resolved into a cell nothing dispatched. **The code does it now**, so the
 * list grows back: `judgeDeclaredAt` (`packages/conductor/src/judge.ts`) answers a
 * runtime as a runtime, and `conduct.ts`'s `ports.judge` is the seam where the
 * `Runtime` and the prompt are ([the-plugin-body.md](../../../doc/design/the-plugin-body.md) §5).
 *
 * **The two halves of the enum are two kinds of decider and not two spellings.**
 * A `BuiltInJudge` is a synchronous function and spends nothing, which is what its
 * own list promises; a `RuntimeId` here is **an agent, paid for a judgement**, and
 * a pass that declares one buys a dispatch every time that direction arrives.
 * `isBuiltInJudge` below is how a reader tells them apart, and nothing else should
 * be comparing a name to `"same-worktree"` by hand.
 *
 * **What it buys is the direction 0061 §3 calls the judgement.** `findings` was
 * seen 231 times in fourteen days and no built-in answers it — every one of those
 * reached a person with the rounds unspent — and it is the one arrival where *the
 * lines are wrong* and *the approach is wrong* are different answers. `red` and
 * `verify-failed` were seen sixty times between them and are mechanical, which is
 * what `BUILT_IN_JUDGES`'s one name is for: declaring a runtime for either is
 * paying an agent to reach a conclusion a `switch` reaches.
 *
 * `ask-or-assume` from 0061 §3's example is still out, and for the reason this
 * list has always had: nothing implements it.
 */
export const JudgeName = z.enum([...BUILT_IN_JUDGES, ...RuntimeId.options]);
export type JudgeName = z.infer<typeof JudgeName>;

/**
 * Which half of `JudgeName` a name is — **a function rather than a comparison
 * anybody writes twice**.
 *
 * The distinction is what decides whether answering costs money, so it is read
 * off `BUILT_IN_JUDGES` in one place: a second built-in added to that list is
 * spending nothing here on the day it is added, and a hand-written
 * `name === "same-worktree"` somewhere else would be the cell that stayed a
 * dispatch.
 */
export function isBuiltInJudge(name: JudgeName): name is BuiltInJudge {
  return (BUILT_IN_JUDGES as readonly string[]).includes(name);
}

/**
 * **Which step is next when something refuses** — a name for the decision
 * `onOffer` and `Ceilings` make in `packages/conductor/src/pass.ts`, which no
 * recipe can see, name or replace today (0061 §3).
 *
 * **One entry per `when:`, and that is the schema rather than a convention.**
 * `when:` is required and has no default, so no entry can answer for all five
 * directions. One judge for all of them pays an agent sixty times to reach a
 * mechanical conclusion — and worse, anyone replacing it has to reimplement the
 * mechanical branches correctly or the loop never terminates.
 *
 * **It declares no `rounds:` and no `restarts:`, and that is the safety
 * property rather than an omission** (0061 §3):
 *
 *     a misconfiguration that fails    is cheap — it errors, you fix it
 *     a misconfiguration that loops    is not — it never errors, it only spends
 *
 * A judge that could carry its own ceilings could answer *back to `implement`*
 * for ever, at ~31 turns and ~$3.40 a round
 * ([012 §3](../../../doc/experiments/012-where-the-turns-go.md)), and nothing
 * anywhere would report a fault. So the two bounds are universal keys on the
 * steps they bound — `rounds` on `implement`, `restarts` on `claim`, written
 * today as `runtime.limits` — and a recipe writing either under a judge is
 * refused by name, listing what this plugin does declare (0061 §9).
 *
 * > **`judge:` decides which step is next. The workflow decides which steps it
 * > may choose from.**
 *
 * The workflow's half is `stepsOnOffer` in
 * `packages/conductor/src/judge.ts`: it counts what is spent, works out the set
 * of steps on offer, and hands the judge that set as a fact. A judge answers
 * *which of these*, never *what is legal*.
 */
export const judgePlugin = definePlugin("judge", {
  fields: {
    /** A built-in, which spends nothing, or a runtime, which is a dispatch (`JudgeName`). */
    judge: JudgeName,
    /** The direction it answers. Required, undefaulted: one entry per `when:`. */
    when: JudgeWhen,
  },
  /**
   * **`proposed` since `#274`, and it is the one step that routes** (0058 §3b).
   *
   * The key is the whole of what makes it legal there, and the reader is the
   * router rather than the pipeline: `judgeDeclaredAt`
   * (`packages/conductor/src/judge.ts`) takes the entry whose `when:` matches the
   * reason the last step gave, `conduct.ts` hands it `recipe.steps.proposed` at
   * `ports.judge`, and the pass applies its answer. So a `judge:` here never
   * becomes an `Action` — `actionsFromRecipe` passes it by for the reason `close:`
   * at `end` is resolved rather than run — and that is why opening the key is not
   * `#61`: the cell resolves *and* something calls it.
   *
   * **Nowhere else, and the reason is `ARRIVE_AT_THE_ROUTER`** (`pass.ts:913`).
   * A refusal at `build`, `review` or `merge` *travels* to `proposed` carrying its
   * reason; the judge is asked once, there, about wherever the pass got to. A
   * `judge:` declared at the refusing step would be a second router at a step that
   * has not finished deciding what its own ending is.
   */
  at: { proposed: notBuiltYet },
});

/**
 * **The bar: the severity at or below which a finding is filed instead of
 * refusing.** `minor` is what the code does today, and the default says so.
 *
 * Read off `SEVERITIES` in `packages/domain/src/events.ts` rather than spelled
 * out, because *at or below* is a comparison of two positions in that list and
 * a copy of the list here would be a second ladder to keep in order. A fourth
 * severity arrives in the enum, the schema and `decideBacklog` at once.
 */
export const BacklogBar = z.enum(SEVERITIES);
export type BacklogBar = z.infer<typeof BacklogBar>;

/**
 * **Where a severity stops being an opinion and becomes an outcome** — a name
 * for `decideBacklog` and for `acceptFinding` / `declineFinding` in
 * `packages/conductor/src/backlog.ts` (`#137`,
 * [0038](../../../doc/decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md) §5).
 *
 * A reviewer returns findings with a severity and **no verdict**
 * ([0058](../../../doc/decisions/0058-lingtai-is-a-development-pipeline.md) §3).
 * Something downstream has to say what a severity costs, and today that is two
 * somethings nobody can name, configure or replace: `verdictFor`
 * (`packages/actions/src/agent-action.ts`), which says what refuses, and a
 * literal `minor` in the fold (`packages/projector/src/backlog.ts`), which says
 * what is filed. The value this plugin carries has to reach both, and
 * `CALLED_DIRECTLY.backlog` below is where that is said to whoever wires it.
 * Nearly half of what a reviewer says arrives at or below the bar —
 * **316 minor and 281 major of 660 findings across 231 refusals in 14 days**
 * ([012 §4](../../../doc/experiments/012-where-the-turns-go.md)) — so the
 * plugin that decides what happens to them is not a footnote.
 *
 * **It routes nothing, and that is the shape of it rather than a limitation.**
 * A step may hold plugins that route and plugins that only act; `judge:` is
 * the one that says which step is next, and `proposed` is still the only step
 * that routes at all. This one is an effect, like `end`'s two: it says which
 * findings are filed, and a filed finding **buys no round** because it never
 * refused. So it declares no `when:` — there is no direction for it to answer
 * — and a recipe writing one is refused by name, listing what it does declare
 * (0061 §9).
 *
 * **And it declares no `kinds:`.** `acceptFinding` is handed the recipe's
 * `source.kinds` so that an accepted entry cannot open an issue of a kind the
 * queue never sees; a second list here would be two answers to *what is a
 * kind*, which is exactly the copy `queuePlugin` shares `QUEUE_FIELDS` to
 * avoid. One list, in one place, doing the job it already does.
 *
 * **No `dedup:` either, because there is nothing to configure.** The same
 * minor raised in round 2 is the same entry: `findingKey`
 * (`packages/domain/src/backlog.ts:24`) is over the ticket, the step, the
 * action, the file and the normalised claim — **no run, no round, no sha** —
 * and the fold writes `on conflict (project, key) do nothing`
 * (`packages/projector/src/backlog.ts:162`). A knob over a property that
 * already holds is a knob whose only reachable value is the one it has.
 */
export const backlogPlugin = definePlugin("backlog", {
  fields: {
    /** At or below this, a finding is filed and buys no round. `minor` today. */
    backlog: BacklogBar.default("minor"),
  },
  /** No step reads it — the bar is a literal in two folds. `CALLED_DIRECTLY.backlog` says where. */
  at: {},
});

/**
 * **The closed set**, and the only list of plugins anywhere.
 *
 * It lists the plugins and not their fields: each of the thirteen above declares
 * what it accepts, and this array is what the resolve walks to find out *which*
 * of them an action names (0061 §9). Every declaration there is lives here, so
 * a key is a bare word and a word that is not one of these is refused. **A
 * declaration arriving from elsewhere does not change that** — 0067 §5 asks for
 * *a key, and a word already taken is refused*, which is this rule with a wider
 * set, not a namespace. What opening it costs is §6's three, and none of them
 * is here: `ActionKind` stops being read off this array, the step × kind matrix
 * becomes two, and a refusal has to name whose fault it is.
 *
 * **`refs:` is the first member that 0061 §3 did not name** (`#240`). The set
 * is not closed against *new* work: §3's list is the names the v2 file gives
 * code that already runs, and a plugin doing something no code did before joins
 * the same set by the same rules — a key, a schema, and an `at` saying which
 * steps it serves. **`file:` is the second** (`#300`): the first destination
 * 0066 §5 asks for, and the first member whose whole job is where an answer
 * *goes* rather than what a step checks.
 *
 * **Two of them serve no step, and they say so themselves** (0064 §4). `queue:`
 * and `backlog:` are
 * names for code the pass calls directly today, so their `at` is `{}` and
 * every step refuses them, by a sentence that says where that code is called
 * instead. That is the same two-valued rule a step nothing implements is held
 * to — **naming a thing is not wiring it** — read down the other axis.
 *
 * **It was five, and three of them have left.** `worktree:` went first (`#268`,
 * `at: { admit }`), `judge:` second (`#274`, `at: { proposed }`) and `merge:`
 * third (`#270`, `at: { merge }`) — each of them a key opened, a default
 * registered in `conduct.ts`'s `defaultsAt`, a body emptied and a
 * `CALLED_DIRECTLY` entry deleted in the one diff, which is what that rule
 * promised would happen and what makes the other two a statement about today
 * rather than a permanent shape.
 *
 * The twelfth was `assignee:`, and it is not missing: 0063 §3 makes it a field
 * of `queue:` rather than a plugin beside it, because the two answer one
 * question and `discover.ts` applies them in one pass over one GitHub response.
 *
 * `as const`, so `ActionKind` and `StepAction` are read off it rather than
 * written down a second time.
 */
export const PLUGINS = [
  runPlugin,
  agentPlugin,
  filePlugin,
  watchPlugin,
  humanPlugin,
  closePlugin,
  labelsPlugin,
  refsPlugin,
  worktreePlugin,
  mergePlugin,
  queuePlugin,
  judgePlugin,
  backlogPlugin,
] as const;

/**
 * One thing that runs at a step.
 *
 * The shape is GitHub Actions' — a `name`, exactly one key saying *which plugin
 * this is*, and that plugin's fields beside it. Copied rather than invented
 * because [ADR 0005](../../../doc/decisions/0005-config-in-target-repo.md)
 * already frames a recipe as a workflow file, and a second dialect for the same
 * idea is a second thing to learn for no gain.
 *
 * A union rather than a discriminated union: the discriminator is *which key is
 * present*, which zod cannot switch on. **What that used to cost is gone**: a
 * malformed action gave the union's own unreadable error, because zod had tried
 * six schemas and could not say which one the writer meant. `actionsAt` asks
 * which key is present first and the plugin that owns it second, so the refusal
 * is that plugin's and names the field. This union is now only what gives the
 * closed set a single type.
 */
export const StepAction = z.union([
  runPlugin.schema,
  agentPlugin.schema,
  filePlugin.schema,
  watchPlugin.schema,
  humanPlugin.schema,
  closePlugin.schema,
  labelsPlugin.schema,
  refsPlugin.schema,
  worktreePlugin.schema,
  mergePlugin.schema,
  queuePlugin.schema,
  judgePlugin.schema,
  backlogPlugin.schema,
]);
export type StepAction = z.infer<typeof StepAction>;

/** The action's kind, for an event and for dispatch. Exactly one key decides it. */
export type ActionKind = (typeof PLUGINS)[number]["key"];

/** The plugin an action names, against the closed set. */
export function pluginOf(action: unknown, plugins: readonly Plugin[] = PLUGINS): Plugin | null {
  return pluginNaming(action, plugins);
}

export function kindOfAction(action: StepAction): ActionKind {
  // The loop rather than `pluginOf`, which answers `null` for an action naming
  // two plugins: a resolved recipe can hold no such thing, and this is read on
  // the board's path where the first key is a better answer than none.
  for (const plugin of PLUGINS) if (plugin.key in action) return plugin.key;
  return "human";
}

/**
 * The resolved steps as anything outside a plugin may see them — every field a
 * plugin marked `noLog` standing in for itself (0061 §9).
 *
 * One function for the log, the board and a refusal, so all three learn a
 * secret field from the one declaration. It answers the object it was given
 * where there is nothing to withhold, which is every recipe today. What a
 * withheld field becomes, and why it is not simply dropped, is `withheld` in
 * `plugin.ts`: a value taken out of the hash would make two recipes that differ
 * in a credential one document (0047 §2).
 */
export function discloseSteps<Steps extends Readonly<Record<string, readonly StepAction[]>>>(
  steps: Steps,
  plugins: readonly PluginSecrets[] = PLUGINS,
): Steps {
  const shown: Record<string, unknown> = {};
  for (const [step, actions] of Object.entries(steps)) {
    shown[step] = actions.map((action) => disclose(action, plugins));
  }
  return shown as Steps;
}

/**
 * **Which plugins serve this step**, read off their own declarations (0064 §4).
 *
 * This is what `KINDS_AT` was, and the difference is where it is written. The
 * table was a hundred and twenty cells answering two questions at once — *is
 * this plugin's output read here* and *has this step been built yet* — and
 * could not tell them apart, which is how `#231` died: it put configuration on
 * steps whose rows were empty for a reason that had nothing to do with what it
 * was asking for. A plugin's `at` can only answer the first.
 *
 * **The guard `#61` bought survives the move, and only its source changed.**
 * Ten cells were once accepted here, resolved into `StepsResolved`, printed by
 * `lingtai add`, drawn on the board — and never called; `merge` was a
 * sixteenth until `#58` built its pipeline. *A control the log claims and the
 * code does not have is worse than an unimplemented one, because every signal
 * an operator has says it is there.*
 */
function pluginsAt(step: Step, plugins: readonly Plugin[]): readonly Plugin[] {
  return plugins.filter((plugin) => servesStep(plugin, step));
}

/**
 * **`WHERE_INSTEAD` is gone, and `#266` is the diff its own rule named.**
 *
 * It held one sentence per step nothing implemented — *today `conduct.ts`
 * dispatches the implementing agent directly* — because *no plugin implements
 * this step* leaves an operator with a key and no next move. The rule beside it
 * was that an entry goes and an `at` key arrives in the same diff, and the entry
 * that outlived every other one was `implement`'s: `build` and `review` went on
 * 2026-09-27 (`a417908`), `admit` with `#268`, `claim` with `#269`, `design`
 * with `#265`, and `agentPlugin` serves `implement` since `#266`.
 *
 * So the table is empty rather than one row long, which is the same fact said
 * once: **every one of 0058 §3's ten steps has a plugin**. The branch below that
 * would have read it is still there and still reachable — `whyNoKindAt` takes a
 * plugin set, and a caller may hand it one that serves nothing — but nothing in
 * `PLUGINS` reaches it, and a sentence about where the work happens instead has
 * no step left to be about.
 */

/**
 * **Why a `judge:` belongs at `proposed` and nowhere else**, and what `proposed`
 * does with the ones it is given.
 *
 * `FILES_AND_ROUTES_NOTHING`'s sibling with the tense changed: `proposed` **reads** its
 * judges since `#274`, so this is no longer a promise about a step that does not
 * do it yet — it is the sentence somebody who wrote one at the wrong step is
 * answered with, and the reduction is what they get when they move it. `#269`
 * took the third sibling away, and took the promise with it: `FIRST_YIELDS` said
 * a `claim` list would reduce to *the first plugin that yields an item*, and what
 * `claim` actually runs is the pipeline — so the list is refused past one entry
 * rather than ordered by a priority it does not have (`queuePlugin`'s `at`).
 *
 * The clause that is not a reduction is the one worth the sentence. **The
 * workflow counts and the judge chooses** (0061 §3) — a judge is handed the set
 * of steps on offer and answers *which of these*, so no replaced judge can
 * widen a ceiling, and a judge that answers outside the set is refused by name
 * rather than obeyed. That is §8's rule once more: *a step refuses a plugin it
 * cannot run* becomes *a step refuses a destination it did not offer*.
 */
const ONLY_PROPOSED_ROUTES =
  "`proposed` is the only step that routes (0058 §3b), and a judge is asked there once about " +
  "wherever the pass got to: a refusal at this step *travels* to it carrying its reason " +
  "(`ARRIVE_AT_THE_ROUTER` in `packages/conductor/src/pass.ts`), so a `judge:` here would be a " +
  "second router at a step that has not finished deciding what its own ending is. Written at " +
  "`proposed` it is read — `proposed` takes the one entry whose `when:` matches the reason the " +
  "last step gave, one judge per direction, and only the `findings` one is a judgement worth an " +
  "agent — and **the workflow counts, the judge chooses** (0061 §3): the workflow reads `rounds` " +
  "and `restarts`, works out which steps are on offer, and hands the judge that set. The set " +
  "depends on how far the pass got and not only on what is left to spend, so a judge answers " +
  "which of these and never what is legal, and one that returns a step it was not offered is " +
  "refused by name";

/**
 * **Why a `merge:` belongs at `merge` and nowhere else**, and what the step does
 * with the one it is given.
 *
 * `ONLY_PROPOSED_ROUTES`'s sibling, and it is the *kind* that answers rather than
 * the step for the same reason that one is: every other branch of `whyThatPair`
 * says *what this step asks of an action*, and none of them can say this. A
 * `merge:` at `prepared` would otherwise fall through to a sentence about a hold
 * that cannot be answered — false where it is printed, which is the failure
 * opening `build` and `review` walked into on 2026-09-27 and the reason
 * `step-matrix.test.ts` pins sentences rather than keywords.
 *
 * The clause worth the sentence is the one that is not about placement:
 * **landing is the last thing a pass does and the only one that changes `main`**,
 * so it happens once, after every other step has passed, and a `merge:` earlier
 * on the spine would land a change the steps after it were about to judge.
 */
const ONLY_THE_LANE_LANDS =
  "`merge` is the last step before `end` and the only one that changes the base branch (0058 §3), " +
  "so a `merge:` is read there and a pass lands once: every step before it has passed by the time " +
  "it runs, which is what makes the merge the one the review was of, and a lane declared earlier on " +
  "the spine would put a change on `main` while the steps after it were still deciding about it. " +
  "Written at `merge` it is read — `integrate` in `packages/repo/src/integrate.ts` merges the base " +
  "in, re-verifies against what landed in the meantime, merges out and pushes — and **it reports a " +
  "reason and decides nothing** (0058 §3c): a refusal carries the lane's own `conflict` or " +
  "`verify-failed` to `proposed`, which is where a round is bought for it. It declares no `base:` " +
  "either, and that is deliberate rather than missing (0061 §4): the base is one value that flows, " +
  "and a second home for it would let what a pass lands disagree with what it was cut from";

/**
 * **Why a `worktree:` belongs at `admit` and nowhere else** — `ONLY_THE_LANE_LANDS`'s
 * sibling at the other end of the spine, and the fourth sentence answered by the
 * *kind*.
 *
 * It is here for the reason that one is, and `#306` is where the cost of its
 * absence was read off the code rather than guessed at: with no branch, a
 * `worktree:` at `proposed` or at `merge` fell past every step branch to
 * `whyThatPair`'s last paragraph and was refused with *a hold at `prepared`
 * cannot be answered* — a sentence about a **hold**, naming a step the operator
 * did not write, for a plugin that is neither. That is the *worse than no
 * reason* this function's docblock is about, and it had been printed at two
 * cells since `#270` gave `merge` a plugin, under a matrix that asserted only
 * that a refusal happened.
 *
 * The clause worth the sentence is the one that is not about placement: **the
 * cut is what every later step runs inside**, so it happens once and before
 * anything, and a `worktree:` further down the spine would move the ground under
 * work already written.
 */
const ONLY_ADMIT_CUTS =
  "`worktree:` is what `admit` does, and `admit` is the only step that does it (0058 §3): a pass is " +
  "cut one branch, before anything has been claimed against it or written in it, and every step " +
  "after that one works inside what the cut made — so a `worktree:` further down the spine would " +
  "move the ground under a change already written, and one before `admit` would ask for a tree while " +
  "the item is still in the queue. Written at `admit` it is read — `createWorktreeAction` in " +
  "`packages/actions/src/worktree-action.ts` provisions it, and a recipe that declares nothing there " +
  "runs that same action off `baseOf`/`submodulesOf` (0065 §2) — and **`base:` is written here and " +
  "nowhere else** (0061 §4): the base is one value that flows to the merge lane rather than a setting " +
  "with two homes, so what a pass lands cannot disagree with what it was cut from";

/**
 * **Why a `queue:` belongs at `claim` and nowhere else** — `ONLY_ADMIT_CUTS`'s
 * sibling one step earlier, and the fifth sentence answered by the *kind*.
 *
 * The same two cells and the same paragraph: a `queue:` at `proposed` or at
 * `merge` was refused with *a hold at `prepared` cannot be answered* until
 * `#306`. And the accident that hid it is worth recording, because it is the one
 * a keyword assertion cannot see — that paragraph ends by offering `proposed` as
 * the remedy, so the refusal printed at `proposed` *contained the step name* and
 * read as though it were about the step it was asked about.
 *
 * The clause worth the sentence is the one about what a take is: **a pass is
 * about one item**, and the step that decides which is the first, so a second
 * take anywhere later would be a pass working one ticket while holding another.
 */
const ONLY_CLAIM_TAKES =
  "`queue:` is what `claim` does, and `claim` is the only step that does it (0058 §3): a pass is " +
  "about one work item, `claim` is where it is decided which, and every step after it is about that " +
  "one — so a `queue:` further down the spine would have a pass working one ticket while holding " +
  "another. Written at `claim` it is read — `createQueueAction` in " +
  "`packages/actions/src/queue-action.ts` re-reads the offer for the issue the pass was pointed at, " +
  "and a recipe that declares nothing there runs that same action off `queueOf(recipe)` (0065 §2) — " +
  "and **it cannot refuse** (0058 §2): a claim that took nothing is holding nothing, so its three " +
  "declines are reported as `did-not-finish` carrying `passed-over`, `not-claimed` or " +
  "`claim-unconfirmed`, and never as a refusal that buys a round. What is *not* this plugin is the " +
  "queue pass — `selectRunnable` in `packages/conductor/src/queue.ts` asks GitHub which issues are " +
  "on offer before a pass exists to have steps, and `backoff` is only read there";

/**
 * **Why a `file:` belongs at `design` and nowhere else** — `ONLY_CLAIM_TAKES`'s
 * sibling, and the sixth sentence answered by the *kind* (`#300`).
 *
 * It is here for the reason the other five are, and `#306` is what makes the
 * reason cheap to state rather than something to rediscover: with no branch, a
 * `file:` at `proposed` or at `merge` would fall past every step branch to
 * `whyThatPair`'s last paragraph and be refused with *a hold at `prepared`
 * cannot be answered* — a sentence about a **hold**, for a plugin that writes a
 * file, naming a step the operator did not write. Five openings shipped that and
 * each was caught by a reviewer; this one lands with the key.
 *
 * The clause worth the sentence is the one that is not about placement: **a
 * destination keeps what a step made, so it can only be written where something
 * is made.** `design` is the one step that produces a document
 * ([0066](../../../doc/decisions/0066-a-large-answer-is-a-locator-on-the-log.md)
 * §3), and every other step's answer is a verdict, which is a sentence on the
 * log already and has nowhere to be kept.
 */
const ONLY_DESIGN_KEEPS =
  "`file:` keeps what a step *made*, and `design` is the one step that makes something large " +
  "(0066 §3): the document goes to a path in the worktree and the path comes back as the locator, " +
  "which is the fact `evidence` carries instead of the whole document. Every other step answers " +
  "with a verdict — a sentence the log already holds — so there is nothing at one for a destination " +
  "to keep. Written at `design` it is read — `createFileAction` in " +
  "`packages/actions/src/file-action.ts` writes the file, and `commit:` says whether it is part of " +
  "the change — and it is written **after** the action that drafts, because it keeps what an earlier " +
  "entry in the same list produced and a `file:` written first has nothing to keep. What it returns " +
  "is a string only this plugin reads (0066 §4): nothing in `packages/conductor` parses a locator, " +
  "which is what lets a second destination join without the core learning about it";

/**
 * **Why a `human:` and a `watch:` are refused at `merge`** — the subtraction
 * `#270` made, and the third sentence answered by the *pair* rather than by the
 * step alone.
 *
 * `ONLY_PROPOSED_ROUTES` and `ONLY_THE_LANE_LANDS` are its siblings, and it exists
 * for the same reason they do: without it these two cells fall through to
 * `whyThatPair`'s last paragraph, which explains that a hold at **`prepared`**
 * cannot be answered. That is true where it is written and false where it would
 * then be printed, which is the exact failure opening `build` and `review` walked
 * into and the reason `step-matrix.test.ts` pins whole sentences.
 *
 * The rule is 0058 §3b's, and it is about who a step may reach rather than about
 * what it asks of an action: `merge` has three ways out, and the third is
 * *anything else → `proposed`, **and only `proposed` may send it to a person***.
 * So the step where a proposed change is inspected — the approval, the glob, the
 * tamper check — is `proposed`, which is where that ADR's own open question puts
 * all three.
 *
 * **And since `#270` the mechanical half of it bites.** The landing is an action in
 * `merge`'s own list, so an approval declared after it would be asked after the
 * branch was already on the base: `#58` with the order reversed, against a merge
 * already made. Refusing the kind is what makes that unwritable rather than
 * something a position rule has to catch.
 */
const ONLY_PROPOSED_ASKS_A_PERSON =
  "`merge` may not reach a person, and that is the third of its three ways out (0058 §3b): a lane " +
  "that refuses carries its reason to `proposed`, **and only `proposed` may send it to a person**. " +
  "So the step where a proposed change is inspected — an approval, a glob over its files, the tamper " +
  "check — is `proposed:`, and that is the step to write this at. Since `#270` the landing is itself " +
  "an action in `merge`'s list (`mergePlugin.at.merge`), so a hold written here would be asked about a " +
  "merge the same list had already made — `#58` with the order reversed. A run that must not merge " +
  "unattended is held at `proposed:`, which is before the lane, or by `lingtai run --no-merge`, whose " +
  "hold is the conductor's own and composes ahead of the lane rather than being declared in the file";

/**
 * **What `proposed` will do with the one plugin of its three that decides
 * nothing about where the pass goes**, and the distinction is the whole of why
 * it is said here.
 *
 * `ONLY_PROPOSED_ROUTES`'s sibling, written for its reason: the reduction is the
 * step's and the step does not do it yet, so the refusal is the one place
 * somebody about to wire it meets the rule.
 *
 * **A step may hold plugins that route and plugins that only act.** `judge:`
 * routes — it answers which step is next — and `proposed` is the only step
 * that routes at all. This one is an effect, like `end`'s two: it decides
 * which findings are filed rather than where anything goes, so there is no
 * reduction over several entries to state and no `when:` to match. What it
 * does decide is what a severity **costs**, and *costs nothing* is the answer
 * worth spelling out: a finding at or below the bar never refused, so no
 * refusal exists for a judge to be asked about and no round is bought.
 */
const FILES_AND_ROUTES_NOTHING =
  "When a step does read it, `proposed` files every finding at or below the bar and **buys no " +
  "round** for one — a finding that did not refuse is not a refusal, so nothing downstream is " +
  "asked what to do about it. It routes nothing and carries no `when:`: a step may hold plugins " +
  "that route and plugins that only act, and `judge:` is the one that says which step is next. " +
  "Filing the same finding twice is not something a recipe can ask for either — `findingKey` in " +
  "`packages/domain/src/backlog.ts` leaves out the run, the round and the sha, so round 2's " +
  "sighting lands on round 1's entry";

/**
 * **The same table read down the other axis**: a plugin the pass calls itself,
 * and where it calls it.
 *
 * `WHERE_INSTEAD` above was *this step is named and not built* and is empty
 * since `#266`; this is *this plugin is named and not read*. Both are `#61`'s failure caught before it can
 * happen, and both say the one thing an operator can act on — not *nothing
 * runs this* but **the code is already running, here, and the recipe is not yet
 * what tells it to**.
 *
 * Why the one left is declared at all before anything reads it: a plugin no
 * list carries is a plugin no step refuses
 * ([`the-v2-recipe.md`](../../../doc/design/the-v2-recipe.md) §3.2). Outside
 * the closed set, `backlog:` written under `end:` is *an action naming no
 * plugin* — a true refusal with the wrong subject, and the cell nobody
 * decided. Inside it, the refusal is the sentence below, and the day the file
 * becomes `steps:` this entry goes and an `at` key arrives on the plugin in
 * the same diff.
 *
 * **`judge:` was the fifth and `merge:` the fourth, and both are the day that
 * happened** (`#274`, `#270`). Each served no step while the pass's body did its
 * work; each serves one now — the router reads the `judge:` entry whose `when:`
 * matches, and `merge`'s own step runs the lane — and so their entries here went
 * with the keys that opened, which is the second half of the rule above, paid
 * out twice. What was true of them is `ONLY_PROPOSED_ROUTES` and
 * `ONLY_THE_LANE_LANDS` now, which are sentences about the pair rather than about
 * the plugin, because each is only wrong *at the other nine steps*.
 *
 * **`queue:` was the third and is `#269`**, which leaves one. It said *the queue
 * asks GitHub itself, before a pass exists to have steps*, and half of that is
 * still true and is not this table's business: `selectRunnable` in
 * `packages/conductor/src/queue.ts` still asks before any pass, and `claim` is the
 * pass's own re-read of the answer for the issue it was pointed at. The half that
 * has gone is *no step reads it* — `queuePlugin.at` carries `claim`, the action is
 * `createQueueAction`, and `queuePlugin`'s own comment is where that is said.
 *
 * `assignee:` was the sixth and the case that document wrote the rule about —
 * it had a row in 0061 §3 and appeared in no other list. It is gone from here
 * because 0063 §3 made it a field of `queue:` rather than a plugin, so the cell
 * it would have had does not exist; what was true of it is now carried by
 * `queuePlugin`'s `at`, which names `assigneeSkip` beside the other two.
 */
const CALLED_DIRECTLY: Partial<Record<ActionKind, string>> = {
  backlog:
    "**the bar is in two places and wiring one of them changes nothing.** `verdictFor` in " +
    "`packages/actions/src/agent-action.ts` decides what **refuses**, off a hard-coded blocker-or-major; " +
    "`backlogProjection` in `packages/projector/src/backlog.ts` decides what is **filed**, off a literal " +
    "`minor`. They are one comparison written twice, in two packages that cannot see each other, and " +
    "`decideBacklog` in `packages/conductor/src/backlog.ts` is that comparison as a function a recipe " +
    "will hand its own value. **Both halves take it or neither does**: a step that replaces the fold's " +
    "literal alone still gets `failed` out of `verdictFor` for a major, still records a refusal, and the " +
    "fold files only out of a passing step — so a recipe that said a major costs nothing would buy a fix " +
    "round exactly as it does today, and read as honoured. What a person then does with a filed one is " +
    "`acceptFinding` and " +
    `\`declineFinding\` in the same module, which \`lingtai backlog\` and the board both call. ${FILES_AND_ROUTES_NOTHING}`,
};

/**
 * **Where a plugin does live**, for the refusal that has to say so.
 *
 * *`close:` does not implement `proposed`* is half an answer; *it serves
 * `end`* is the half somebody can act on, and it is read off the plugin's own
 * `at` rather than looked up anywhere (0064 §4).
 */
function servedBy(plugin: Plugin): string {
  return plugin.serves.length === 0
    ? "it serves no step at all"
    : `it serves ${plugin.serves.map((served) => `\`${served}\``).join(", ")}`;
}

/**
 * Why a step does not run a kind, in the words the refusal carries — or `null`
 * when it does.
 *
 * **The answer is the plugin's own `at`, and there is no table** (0064 §4).
 * What follows the *no* is not: a refusal that only said *not here* would
 * leave an operator with a recipe key and no next move, so every branch below
 * says where the thing they were trying to configure actually is.
 *
 * **Three kinds of no, and they are asked in this order.**
 *
 * - **A plugin no step reads** — `backlog:` alone, which serves nothing and is
 *   refused everywhere for one reason. Asked first, because a sentence about the
 *   *step* would be the less useful half of the truth at all ten: *no plugin
 *   implements `end`* would be right about a step nothing decides and leave a
 *   reader looking for the bar that files a finding, which `CALLED_DIRECTLY`
 *   names. **It was five**, and `worktree:` (`#268`), `judge:` (`#274`), `merge:`
 *   (`#270`) and `queue:` (`#269`) have each left it for a key of their own —
 *   which is what this branch shrinking looks like. `backlog:` is what is left.
 * - **A step no plugin implements**, which is the sentence the table could not
 *   say (0064 §1). An empty row read as *this step takes nothing*, which is
 *   indistinguishable from *nobody has built it* — and that ambiguity is how
 *   `#231` died. **No step in `PLUGINS` reaches it since `#266`**, which is what
 *   emptied `WHERE_INSTEAD`; a caller that hands in its own plugin set still can.
 * - **A step somebody implements and this plugin does not.** Then the useful
 *   thing is where this plugin *does* serve, and the reason is about the pair.
 */
export function whyNoKindAt(
  step: Step,
  kind: ActionKind,
  plugins: readonly Plugin[] = PLUGINS,
): string | null {
  const plugin = plugins.find((each) => each.key === kind) ?? null;
  if (plugin !== null && servesStep(plugin, step)) return null;

  const calledDirectly = CALLED_DIRECTLY[kind];
  if (calledDirectly !== undefined) {
    return (
      `no step reads a \`${kind}:\` action from the recipe yet — the plugin is the name ` +
      "[0061](doc/decisions/0061-the-recipe-is-the-pipeline.md) §3 gives code the pass already runs, and " +
      `it is wired to the recipe by the ticket that makes the file \`steps:\`. Today ${calledDirectly}. ` +
      "Refused rather than accepted here because an action nothing reads would be resolved, recorded on " +
      "the log, printed by `lingtai add`, drawn on the board — and never called (`#61`)"
    );
  }

  // **A step nobody has built, said as that and not as *it takes nothing*.**
  // Under the table these two were one empty row; under `at` they are the
  // presence or absence of a key, and this is the sentence that difference
  // buys — one somebody can act on, because it names what to write instead.
  if (pluginsAt(step, plugins).length === 0) {
    // **No `Today …` clause since `#266`**: it was `WHERE_INSTEAD`'s, one
    // sentence per step, and every step in `PLUGINS` has a key now — so what is
    // left is the refusal itself, for a caller that handed in a plugin set of
    // its own.
    return (
      `no plugin implements \`${step}\` — the step is named by ` +
      "[0058](doc/decisions/0058-lingtai-is-a-development-pipeline.md) §3 so that the log, the recipe and the board " +
      "have a word for it, and no plugin's `at` carries that key yet. " +
      "Refused rather than accepted here because an action at a step nothing implements would be resolved, recorded " +
      "in `StepsResolved`, printed by `lingtai add`, drawn on the board — and never called (`#61`)"
    );
  }

  // Somebody serves this step and this plugin does not, so the answer leads
  // with where this one does live and then says why the pair is meaningless.
  const wrongStep =
    plugin === null
      ? `no plugin is named \`${kind}:\``
      : `\`${kind}:\` does not implement \`${step}\` — ${servedBy(plugin)}`;
  return `${wrongStep}: ${whyThatPair(step, kind)}`;
}

/**
 * Why this plugin's output would mean nothing at this step, said in the step's
 * own terms.
 *
 * **Answered by step first and by kind second, and the order is load-bearing.**
 * Every branch here was written when `prepared` was the only step that served
 * some kinds and refused others, so the three at the bottom name `prepared` in
 * as many words. `build` and `review` opened on 2026-09-27 and joined that
 * shape — an `agent:` at `build` stopped taking the *no plugin implements this
 * step* branch and fell through to a sentence saying *nothing has been
 * committed at `prepared`*, where in fact the agent has committed and the true
 * reason is that `agentPlugin` has no `build` key. A refusal naming a step the
 * operator never wrote, for a reason that is false where it is printed, is
 * worse than no reason: `step-matrix.test.ts` pins the sentence at each of
 * them rather than the keywords, because *contains the step name* passes on
 * the opening clause alone and let exactly this through.
 *
 * **So a branch here lands in the same diff as the key that needs it** — this
 * is the fourth thing 0065 §7's *one diff or not at all* covers, beside the
 * `at` key, the `defaultsAt` row and the emptied body. Until a step has a
 * plugin, `whyNoKindAt` answers every kind at it from the *no plugin implements
 * this* branch and never reaches here; the moment one arrives, every other kind
 * it does not serve falls through to the three paragraphs at the bottom and is
 * told about `prepared`. `admit` (`#268`), `merge` (`#270`), `claim` (`#269`),
 * `design` (`#265`) and `implement` (`#266`) each brought their own — **five for
 * five, and each one caught by the cold reviewer rather than by a test**, which
 * is what `#306` is about and what the case in `step-matrix.test.ts` now holds.
 *
 * **`judge:` is answered by kind before any step but `end`** (`#274`), and that
 * is the one inversion of the order above. Every other branch says *what this
 * step asks of an action*, and a judge is not an action: it is asked once a step
 * has already decided, so the true reason is the same at `prepared`, `build`,
 * `review` and `merge` alike — the router is `proposed`, and a refusal here
 * travels to it. `end` keeps its own sentence because it is the one that names
 * `judge:`'s `when:` in order to say what picks the three effects out.
 *
 * **And five kinds are answered that way now, not one** (`#306`, `#300`). `file:`
 * is the fifth and is the one that arrived with its branch rather than after it:
 * a destination keeps what a step *made*, which is a sentence about the plugin
 * and is wrong at nine steps for one reason (`ONLY_DESIGN_KEEPS`). `merge:` joined
 * it with `#270`; `worktree:` and `queue:` join it here, because the cells they
 * had at `prepared`, `proposed` and `merge` were being answered with the last
 * paragraph below — *a hold at `prepared` cannot be answered*, printed for a
 * plugin that is not a hold, at a step the operator did not write. The rule the
 * four share is that **their output is one step's own work**: a cut, a take, a
 * landing, a routing decision. No step branch can say why one is meaningless
 * somewhere else, because the sentence is about the plugin.
 *
 * So the step branches below answer exactly the four kinds a step *could*
 * plausibly carry — `run:`, `agent:`, `watch:`, `human:` — and
 * `step-matrix.test.ts` asserts, cell by cell, that each of those is answered by
 * a sentence no other step gives: the fall-through that five openings shipped is
 * a red test rather than a reviewer's good day.
 */
function whyThatPair(step: Step, kind: ActionKind): string {
  if (step === "end") {
    return (
      "`end` fires on every terminal outcome and produces no verdict, so the only actions it can " +
      "carry are the three that run for effect — `close:`, `labels:` and `refs:`, whose `when:` is " +
      "which of those outcomes it was. It is not that they are the plugins with a `when:` field: " +
      "`judge:` declares one too and reads the reason the last step gave (`#238`), so what picks " +
      "these three out is the kind and never the shape"
    );
  }
  if (kind === "judge") return ONLY_PROPOSED_ROUTES;
  if (kind === "merge") return ONLY_THE_LANE_LANDS;
  if (kind === "worktree") return ONLY_ADMIT_CUTS;
  if (kind === "queue") return ONLY_CLAIM_TAKES;
  if (kind === "file") return ONLY_DESIGN_KEEPS;
  // Before the step branches and not after them, for `judge:`'s reason (`#270`):
  // what is wrong with a hold at `merge` is not what `merge` asks of an action but
  // who it may reach, and the sentence below about `prepared` would otherwise be
  // printed at a step where it is false.
  if (step === "merge" && (kind === "human" || kind === "watch")) return ONLY_PROPOSED_ASKS_A_PERSON;
  if (kind === "close" || kind === "labels" || kind === "refs") {
    return "it is an effect rather than a verdict, and only the `end` step carries out effects";
  }
  if (step === "review") {
    return (
      "`review` returns findings and judges nothing (0058 §3b) — `pass.ts` makes its ending `passed` " +
      "whatever the action said, so a verdict declared here is one the step throws away, and `agent:` " +
      "is the only plugin that answers with findings rather than with a verdict. A command that decides " +
      "whether the diff stands is a `run:` at `build`; a glob over it or a hold on it is `proposed`'s"
    );
  }
  if (step === "build") {
    return (
      "`build` is the independent build of what was written (0058 §3), and what it asks of an action is " +
      "a command's exit code — `run:` is the one plugin declared there, and none of the other three " +
      "builds anything. An agent asked to would be paid to read, and a cold read of the diff is " +
      "`review`; a glob over the diff's file list and a hold on it are questions about a change already " +
      "built, which is `proposed`"
    );
  }
  if (step === "claim") {
    return (
      "`claim` picks the ticket the pass is about and does nothing else (0058 §3), so the only plugin " +
      "it carries is the one that picks — `queue:`, which is the key `queuePlugin` declares there. " +
      "Nothing has been claimed, cut or written when this step runs, so a command has no worktree to " +
      "run in and belongs at `prepared`, an agent has no diff to read and a glob no file list to " +
      "match. A hold is the one that reads as though it would work: asked here it is asked either " +
      "about no ticket at all, or about one this run is already holding for the whole of the wait. " +
      "`lingtai ask` is the question that belongs before a claim — it holds the item in the queue, " +
      "and it is answered without a run having been paid for"
    );
  }
  if (step === "admit") {
    return (
      "`admit` cuts the branch a pass owns and does nothing else (0058 §3), so the only plugin it " +
      "carries is the one that cuts — `worktree:`, which is the key `worktreePlugin` declares there. " +
      "There is no worktree until this step has made one, so a command has nowhere to run and belongs " +
      "at `prepared`, and nothing has been written, so an agent has no diff to read and a glob no file " +
      "list to match. A question that has to be asked before anything is spent is `lingtai ask`, which " +
      "holds the item in the queue rather than a run that has already paid for a clone"
    );
  }
  if (step === "design") {
    return (
      "`design` produces a document before any code, or nothing, which is an answer (0058 §3), so the " +
      "two plugins it carries are the one that can write one — `agent:`, which is the key `agentPlugin` " +
      "declares there, and at this step it drafts rather than reviews — and the one that keeps it, " +
      "`file:`, which writes it to a path and returns that path as the locator. Nothing has been committed when " +
      "this step runs, so a command has no diff to check and belongs at `build`, a cold read of one is " +
      "`review`, and a glob has no file list to match. A hold is the one that reads as though it would " +
      "work: a question about a change is a question about a change that exists, and `proposed:` is " +
      "where there is a diff to ask it about"
    );
  }
  if (step === "implement") {
    return (
      "`implement` is the change itself (0058 §3), so the only plugin it carries is the one that " +
      "writes one — `agent:`, which is the key `agentPlugin` declares there, and at this step it " +
      "implements rather than reads. The step's own receipt is a commit (0057 §2), which is what " +
      "none of the other three can leave: a command that checks what was written is `build`, a " +
      "cold read of it is `review`, a glob over its file list and a hold on it are questions about " +
      "a change already made, which is `proposed`"
    );
  }
  if (kind === "agent") {
    return "nothing has been committed at `prepared`, so a cold reviewer would be given no diff to read";
  }
  if (kind === "watch") {
    return "nothing has been committed at `prepared`, so the globs would be matched against no file list";
  }
  return (
    "a hold at `prepared` cannot be answered — the run is released back to the queue and the " +
    "question goes with it, so the item would re-claim, re-install and ask again on every pass. " +
    "Ask before the claim with `lingtai ask`, or at `proposed`, where there is a diff to approve"
  );
}

/**
 * The refusal, in the one wording the schema and `actionsFromRecipe` both use.
 *
 * **`tail` is the rest of the sentence, and it has a default rather than a
 * second function** (0061 §9). §8's rule grew one clause — *a step refuses a
 * plugin it cannot run, and a plugin refuses a field it does not understand* —
 * and the two halves of it have to read as one rule: the same opening names the
 * action, its kind and the step either way, and only what follows differs.
 */
export function kindRefusedAt(
  step: Step,
  kind: ActionKind,
  action: string,
  why: string,
  tail = "Refusing rather than accepting it: an action that is silently absent is worse than a run that will not start.",
): string {
  return `the "${action}" action is a "${kind}" at the "${step}" step, and ${why}. ${tail}`;
}

/** What a plugin's own refusal of a field says after the sentence above. */
const REFUSED_WHEN_IT_RESOLVED =
  "Refused when the recipe resolves, before a worktree, before an agent, before any money.";

/** What an action naming no plugin, or two, is told — and what the legal names are. */
function pluginRefusedAt(step: Step, action: unknown, named: readonly Plugin[]): string {
  const called = nameOf(action);
  const legal = PLUGINS.map((plugin) => `"${plugin.key}"`).join(", ");
  return named.length === 0
    ? `the "${called}" action at the "${step}" step names no plugin — an action carries exactly one of ` +
        `${legal}, and that key is what it is. Refusing rather than accepting it: an action that is ` +
        "silently absent is worse than a run that will not start."
    : `the "${called}" action at the "${step}" step names ${named.length} plugins — ` +
        `${named.map((plugin) => `"${plugin.key}"`).join(" and ")} — and an action carries exactly one. ` +
        "Which of them was meant is not Lingtai's to guess.";
}

/** What a refusal calls an action whose `name` may itself be what is wrong. */
function nameOf(action: unknown): string {
  const written = (action as { name?: unknown } | null)?.name;
  return typeof written === "string" ? written : "(unnamed)";
}

/**
 * One step's actions: the plugin each one names, checked by that plugin, and
 * **every** problem in one answer.
 *
 * The refusal is here rather than in the conductor because this is the file a
 * recipe is read by, and a step that cannot run the action should say so when
 * the recipe resolves — before a ticket is claimed, a worktree cut, or an
 * install paid for. `lingtai doctor`, `lingtai add` and every pass resolve the
 * recipe, so all three name it.
 *
 * **Three questions in order, and each one is somebody's.** *Which plugin is
 * this* is the shape's, *may this step run it* is the step's (`whyNoKindAt`),
 * and *are these its fields* is the plugin's (`readFields`). They stop at the
 * first that answers, because a field's wording is moot under an action the
 * step will not run at all — but an action that stops does not stop the ones
 * after it, and a step that stops does not stop the other nine. A resolve that
 * halted at the first bad field would make a person fix one thing per attempt,
 * which is `#222`'s lesson about the build step applied to configuration.
 *
 * **Then five questions about the list rather than about one action**, asked
 * last because each is only answerable once the entries either side have been
 * accepted: *does this step cut twice* (`#268`), *does it take twice* (`#269`),
 * *is anything written after the lane* and *is a step written with no lane at
 * all* (both `#270`), and *is a destination written before the thing it keeps*
 * (`#300`). They are the only rules here about an action's
 * neighbours, and each exists because the plugin it is about does something the
 * rest do not — two of them *make* what the pass is about, the worktree and the
 * work item, two are the one action that changes the base branch,
 * asked from both sides (nothing may follow the lane, and a written step that
 * could land may not omit it), and the last is the one that keeps rather than
 * makes or judges, so its place in the list is the whole of whether it has
 * anything to keep.
 *
 * `z.unknown()` rather than the union, so the dispatch is the key's and not
 * zod's: a union tries six schemas and reports six failures about one action.
 */
function actionsAt(step: Step) {
  return z
    .array(z.unknown())
    .transform((written, ctx) => {
      const resolved: StepAction[] = [];
      /** Where each accepted `worktree:` was written, for the refusal below. */
      const cuts: number[] = [];
      /** Where each accepted `queue:` was written, for the refusal below. */
      const takes: number[] = [];
      /** Where an accepted `merge:` was written, if one has been — the refusal below. */
      let landsAt: number | null = null;
      written.forEach((action, i) => {
        const named = pluginsNamed(action, PLUGINS);
        const plugin = pluginNaming(action, PLUGINS);
        if (plugin === null) {
          ctx.addIssue({ code: "custom", path: [i], message: pluginRefusedAt(step, action, named) });
          return;
        }
        const kind = plugin.key as ActionKind;
        const why = whyNoKindAt(step, kind);
        if (why !== null) {
          ctx.addIssue({ code: "custom", path: [i], message: kindRefusedAt(step, kind, nameOf(action), why) });
          return;
        }
        const read = readFields(plugin, action);
        if (read.problems !== undefined) {
          for (const problem of read.problems) {
            ctx.addIssue({
              code: "custom",
              path: [i, ...problem.at],
              message: kindRefusedAt(step, kind, nameOf(action), problem.why, REFUSED_WHEN_IT_RESOLVED),
            });
          }
          return;
        }
        /**
         * **The lane is the last action at its step, and anything written after
         * it is refused** (0065 §8, `#270`).
         *
         * Asked in the loop rather than after it because the entries arrive in
         * order, so *a lane has already been accepted* is the whole of the
         * question — and it catches a second `merge:` by the same clause that
         * catches a `run:`, since both are *something after the thing that
         * lands*.
         *
         * The failure it removes is not a style one. Every declared action at a
         * step runs (0065 §2) and the pass reads its ending off the pipeline, so
         * a `run: pnpm smoke` written after the lane runs on a branch already on
         * the base: the merge happened, the check fails, `endingOf` reports
         * `merge` refused, no `WorkItemLanded` is appended, `end`'s `when:
         * landed` effects never fire, and the item is blocked with its diff on
         * `main` for a later pass to work again. A check that must gate the merge
         * goes before the lane, which is where a reader would write it anyway.
         */
        if (landsAt !== null) {
          ctx.addIssue({
            code: "custom",
            path: [i],
            message: kindRefusedAt(
              step,
              kind,
              nameOf(action),
              `the "${step}" step lands the branch at entry ${landsAt}, and the lane is the last action ` +
                "a step carries. This one is written after it, so it would run on a change already on the " +
                "base branch — and a verdict it gave there would report the step refused while the merge " +
                "stood, leaving the diff landed and the ticket blocked. Write it before the lane",
              REFUSED_WHEN_IT_RESOLVED,
            ),
          });
          return;
        }

        /**
         * **A destination is written after the thing it keeps** (`#300`).
         *
         * `file:` keeps a document an earlier entry in the same list made —
         * `runActionPipeline` hands each result's document forward on
         * `ActionContext.design` — so a `file:` at entry 0 has nothing to keep.
         * What it would do is pass having written nothing, with a locator nobody
         * can follow and a card saying the step kept a design: `#61`'s failure
         * reached through an order rather than through a missing call site, and
         * silent in the direction that matters, because the recipe reads as
         * though the design is being kept.
         *
         * Asked in the loop for the lane's reason — the entries arrive in order,
         * so *is this the first* is the whole of the question — and by position
         * rather than by naming `agent:`, because *which plugin makes a document*
         * is that plugin's to know (0031 §1) and a list of them here would be a
         * list to keep true.
         */
        if (kind === "file" && i === 0) {
          ctx.addIssue({
            code: "custom",
            path: [i],
            message: kindRefusedAt(
              step,
              kind,
              nameOf(action),
              "it is the first action there, and a `file:` keeps what an earlier " +
                "action made rather than making anything itself — so written first it has nothing to " +
                "keep, and would pass having written no file and returned no locator. Write it after " +
                "the action that drafts the document",
              REFUSED_WHEN_IT_RESOLVED,
            ),
          });
          return;
        }

        if (kind === "worktree") cuts.push(i);
        if (kind === "queue") takes.push(i);
        if (kind === "merge") landsAt = i;
        resolved.push(read.value as StepAction);
      });
      /**
       * **One cut, and a second `worktree:` is refused rather than merged**
       * (`#268`).
       *
       * Every declared action at a step runs (0065 §2), so two of these would
       * cut the same path twice — and `baseOf` would have to pick one, leaving
       * the other displayed on the board, hashed into `configHash` and recorded
       * in `StepsResolved` while something else is what ran. That is `#61`'s
       * shape reached through a duplicate rather than through a missing call
       * site, and it is the one plugin it can happen to: `worktree:` is the only
       * one that *makes* what the rest of the pass works in, so where a second
       * `run:` is two commands, a second `worktree:` is two answers to one
       * question. Which was meant is not Lingtai's to guess.
       */
      for (const i of cuts.slice(1)) {
        ctx.addIssue({
          code: "custom",
          path: [i],
          message: kindRefusedAt(
            step,
            "worktree",
            nameOf(written[i]),
            `the "${step}" step already cuts a worktree at entry ${cuts[0]}, and a step cuts one or ` +
              "none. Two of them would cut the same path twice, and the base a reading shows would " +
              "not be the base the pass was cut from",
            REFUSED_WHEN_IT_RESOLVED,
          ),
        });
      }
      /**
       * **One take, and a second `queue:` is refused rather than ordered**
       * (`#269`).
       *
       * 0061 §2 said a `claim` list would reduce to *the first plugin that yields
       * a work item*, and `FIRST_YIELDS` promised it in the refusal `queue:` used
       * to carry. What `claim` actually runs is `runActionPipeline`, which stops
       * at the first action that did **not** pass — so two entries are *both must
       * agree*, and the second is never reached where the first took the ticket.
       * A list whose order reads as a priority it does not have is `#61`'s shape
       * through a duplicate: resolved, printed by `lingtai add`, drawn on the
       * board, and not what ran.
       *
       * `worktree:`'s sibling above and refused for the same half of the reason —
       * `queue:` is the other plugin that *makes* something the rest of the pass
       * is about rather than judging something already there, so where a second
       * `run:` is two commands, a second `queue:` is two answers to *which
       * ticket*. Which was meant is not Lingtai's to guess.
       */
      for (const i of takes.slice(1)) {
        ctx.addIssue({
          code: "custom",
          path: [i],
          message: kindRefusedAt(
            step,
            "queue",
            nameOf(written[i]),
            `the "${step}" step already takes a ticket at entry ${takes[0]}, and a step takes one or ` +
              "none. The pipeline stops at the first action that did not pass, so a second one is " +
              "never reached where the first took the ticket and is *also required* where it did not — " +
              "which is not the priority order a list reads as",
            REFUSED_WHEN_IT_RESOLVED,
          ),
        });
      }
      /**
       * **A step that is written and does not land is refused** (`#270`).
       *
       * What has no reading is a `merge:` carrying checks and no lane. Every
       * declared action at a step runs (0065 §2) and the pass reads the step's
       * ending off the pipeline, so a list of green checks with nothing that
       * lands reports the step **passed** and `outcomeOf` reads `landed`. What
       * does not follow is a landing: the append is guarded on the lane's own
       * commit — `const merged = landedAt(); if (outcome === "landed" && merged
       * !== null)` in `conduct.ts` — and no lane ran, so there is no
       * `WorkItemLanded`, no `endPlan`, `end`'s `when: landed` effects never
       * fire, the issue is never closed, and the pass falls through to the
       * failed tail under *the pass ended without landing and without asking
       * anybody*. The next pass takes the same ticket and buys a fresh agent for
       * a diff still sitting on the branch. That is `#61`'s failure —
       * configured, drawn, and not what ran — reached through an omission rather
       * than a duplicate, and it is silent in the one direction that costs money.
       *
       * **`merge: []` is a different statement, which is why this cannot simply
       * demand a non-empty list — and it is not a step that runs nothing.**
       * 0065 §6 *decides* the empty list will mean that, and that part of §6 is
       * unbuilt: `StepMap` resolves `[]` and an omitted key to the same value, so
       * at the seam `merge: []` takes the default lane and **merges**
       * (`conduct.ts`'s `defaultsAt`, and `conduct-a-whole-pass.test.ts`'s *lands
       * onto main with `merge: []`*), which is what this repository runs on.
       * Either reading refuses a rule demanding a non-empty list: today it would
       * refuse this machine's own recipe, and after §6 it would refuse the
       * deliberate *land nothing*. So the question asked here is *is this step
       * written, and does nothing in it land*, and an empty list is not written —
       * which is why the refusal below does not offer it as a way to land
       * nothing. The hold that does that is a `human:` at `proposed:`.
       *
       * Scoped by `whyNoKindAt` rather than by naming the step, because *is the
       * lane on offer here* is the plugin's own `at` to answer (0064 §4) and a
       * second step that lands would otherwise get the rule silently skipped.
       *
       * Asked only where every entry resolved, because a refused entry may have
       * been the lane: *is a lane present* is not answerable about a list one of
       * whose actions Lingtai could not read. The person fixes that one, and
       * this rule sees the list on the next resolve.
       */
      if (
        written.length > 0 &&
        resolved.length === written.length &&
        landsAt === null &&
        whyNoKindAt(step, "merge") === null
      ) {
        ctx.addIssue({
          code: "custom",
          path: [],
          message:
            `the "${step}" step is written with ${written.length} action` +
            `${written.length === 1 ? "" : "s"} and none of them is the lane, so the step would ` +
            "pass having landed nothing — and nothing follows from that: the `WorkItemLanded` " +
            "append is guarded on the lane's own commit, so the pass falls through to the failed " +
            "tail, releases the ticket and buys a second agent for the same diff. Write the lane " +
            `last. An empty "${step}: []" resolves, but it is not the way to land nothing — the ` +
            "conductor reads it as the omitted key, so the default lane runs and the branch merges " +
            "(0065 §6 decides otherwise and is not built yet). To hold a pass before anything " +
            "lands, declare a `human:` action at `proposed:`. " +
            REFUSED_WHEN_IT_RESOLVED,
        });
      }
      return resolved;
    })
    .default([]);
}

/**
 * What runs at each of the ten steps.
 *
 * Every step is present and defaults to empty, which is the whole design in
 * one line: **an unconfigured step is skipped, and the skip is visible.** A
 * missing key here is not "undefined", it is "nothing runs, and the board says
 * so" (ADR 0016 §4). That is also
 * [0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §5 — *the
 * file may omit a step; the resolved recipe may not* — and this object is the
 * mechanism that ADR names.
 *
 * Order within a step is the array's. The first refusal wins and the actions
 * after it do not run — continuing would spend money producing verdicts about a
 * diff that is not going anywhere.
 *
 * **Strict, and that is what makes the closed set enforceable.** A key that is
 * not one of the ten is a typo or a stale name, and zod's default is to drop
 * it silently — which would mean a recipe whose `merg:` block never runs and a
 * board that says `skipped` because it was told nothing was configured. That is
 * exactly the "configured and did not run" failure the model calls Lingtai's
 * bug (ADR 0016 §4). It is also what a recipe still saying `diff:` would hit
 * after [0018](../../../doc/decisions/0018-the-proposed-point.md): it fails to
 * resolve, loudly, naming the key.
 *
 * **Strict about the kind at a step, too, and for the same reason** (`#61`).
 * A key that *is* one of the ten, carrying an action that step does not run,
 * is the identical failure reached one level down: it resolves, it is drawn,
 * and nothing happens. Each plugin's `at` is which pairs run (0064 §4) and
 * `whyNoKindAt` is what the refusal says — and it is what keeps the five steps
 * 0058 §3 named but nothing implements from becoming five silent cells: their
 * keys parse, and any action in them is refused with the step's own sentence.
 */
export const StepMap = z.strictObject({
  claim: actionsAt("claim"),
  admit: actionsAt("admit"),
  prepared: actionsAt("prepared"),
  design: actionsAt("design"),
  implement: actionsAt("implement"),
  build: actionsAt("build"),
  review: actionsAt("review"),
  /** Was `diff` until [0018](../../../doc/decisions/0018-the-proposed-point.md). */
  proposed: actionsAt("proposed"),
  merge: actionsAt("merge"),
  end: actionsAt("end"),
});
export type StepMap = z.infer<typeof StepMap>;

/**
 * An event type the log actually has, as a subscription's `on:` entry.
 *
 * **The check is the whole point of putting `on:` in the recipe.** A name that
 * is not in the catalogue is a typo or a name that has moved, and the failure
 * it produces without this is the worst kind a notifier can have: a
 * subscription that parses, resolves, renders, and never once fires. Nobody
 * finds that out — you only ever notice the message you did not get.
 *
 * So it names the offending string rather than saying the list is wrong, the
 * same way `env`'s strictness names the misspelled key. `EVENTS` in
 * `packages/domain/src/events.ts` is the catalogue, and `isEventType` is the
 * one reading of it — a second list here would be a list to keep correct.
 *
 * A **retired** type is refused for the same reason and said differently: it is
 * spelled right, it is in the catalogue, and nothing appends it any more
 * (`RETIRED`), so subscribing to it is the identical silent nothing reached by
 * a different mistake.
 */
const SubscribedEvent = z.string().superRefine((name, ctx) => {
  if (isRetiredEventType(name)) {
    ctx.addIssue({
      code: "custom",
      message: `"${name}" is a retired event type — nothing appends it any more, so this would never fire`,
    });
    return;
  }
  if (!isEventType(name)) {
    ctx.addIssue({
      code: "custom",
      message: `"${name}" is not an event type — the catalogue is EVENTS in packages/domain/src/events.ts`,
    });
  }
});

/**
 * Something told about events, which the loop does not wait for
 * ([0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §3).
 *
 * The same `run:` a gate action has, and the whole of the difference is that
 * nothing reads the exit code: a gate action's verdict is about a commit, and
 * this one has no verdict. That is 0016 §5's rule — *if the loop must wait for
 * it, it is a gate action; if it cannot affect the outcome, it is a
 * subscriber* — with the mechanism filled in and nothing declared underneath
 * it: a subscriber is a command, so no key of its own goes in `PLUGINS`.
 *
 * **One mechanism doing two jobs.** `on:` is both the declaration of what this
 * subscriber is for and the subscription itself, so the core knows what it
 * wants before it spends a process finding out. That is what VS Code's
 * activation events buy, and it is the half of their design worth copying.
 *
 * **Strict, for the reason `StepMap` and `env` are.** A key that is not one of
 * the four is a typo or a name from a draft of 0037 — `events:`, `uses:` — and
 * zod's default is to drop it silently, which here would mean a subscriber
 * subscribed to nothing while the recipe reads as though it were configured.
 */
export const Subscriber = z.strictObject({
  name: z.string(),
  /** The types it wants. Empty is not a subscriber, it is a command nobody runs. */
  on: z.array(SubscribedEvent).min(1),
  /** The command. Its exit code is discarded — see 0037 §5. */
  run: z.string(),
  /**
   * Every credential this subscriber gets, and nothing else reaches it — see
   * `ExtensionEnvNames`.
   *
   * This is the case 0037 §1 is written about in as many words: *"a Telegram
   * bot token must reach the Telegram extension and nothing else"*. Declaring
   * it beside the subscriber is what makes "and nothing else" a fact rather
   * than an intention, because the alternative — the daemon's own environment —
   * hands it to every extension at once.
   */
  env: ExtensionEnvNames,
});
export type Subscriber = z.infer<typeof Subscriber>;

/**
 * The version this schema is, named in a refusal rather than written twice.
 *
 * **There is no migration, and that is the decision rather than the backlog**
 * ([0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §7). A
 * recipe is one file on one machine, written by the person who owns it, so the
 * cost of rewriting it is minutes — and a migration would have to keep the v1
 * shape readable for ever to save them.
 */
export const RECIPE_VERSION = 2;

/**
 * The version, and **a v1 file refused by name rather than by shape.**
 *
 * `z.literal(2)` alone would say *expected 2, received 1*, which tells somebody
 * holding a working v1 file nothing about what happened to it. 0016 §4 is the
 * rule: a key that silently changed meaning and a key that never existed are
 * different facts to whoever wrote it, and only a named refusal can say which.
 */
const Version = z.number().int().superRefine((written, ctx) => {
  if (written === RECIPE_VERSION) return;
  ctx.addIssue({
    code: "custom",
    message:
      written === 1
        ? "version: 1 is the recipe as it was before 0061 — five of the ten steps " +
          "could be configured and the other five could not, under a key `steps:` " +
          "replaced rather than renamed. There is no migration: rewrite this file " +
          "as `version: 2`, with `steps:` naming the ten steps in pass order, each " +
          "a list of plugins. A step the file leaves out runs nothing."
        : `version: ${written} is not a recipe this Lingtai knows — it reads \`version: ${RECIPE_VERSION}\``,
  });
});

export const Recipe = z.object({
  version: Version,
  /**
   * Pulls install/build/test defaults from a preset shipped with Lingtai.
   *
   * **Kept at the top level in v2, and the preset table is `steps:`.** This
   * repository does not use it, so removing it would break nothing here — which
   * is exactly why removing it is not this ticket's call to make: a project that
   * does use one would have no way to write a v2 file at all, and that is a
   * product decision rather than a consequence of renaming a key.
   */
  extends: z.string().optional(),

  repo: z.object({
    base: z.string(),
    /** `git worktree add` does not populate submodules; not doing so breaks every
     *  test that imports one, and reads as "the agent broke the tests". */
    submodules: z.boolean().default(false),
  }),

  /**
   * Getting the worktree workable before the agent starts. Ordered, and the
   * first refusal stops the run.
   *
   * Optional because it is genuinely optional: a Go repository may need nothing
   * at all. But `git worktree add` copies no `node_modules`, so for most of them
   * the absence of this is the difference between an agent that can run the
   * tests and one writing blind.
   *
   * Not a gate. A gate's verdict is about a commit — `onSha` — and a force-push
   * invalidates it by arithmetic. A prepare step runs before the agent has
   * written anything and holds no verdict about anything.
   */
  // **Three of the four fields `queue:` declares, and the same schema
  // objects.** `KINDS`, `EXCLUDE` and `BACKOFF` are where they and their
  // comments are written; this key is the v1 spelling of them, and the plugin is
  // the v2 one. One declaration, because two would be two things to keep true —
  // and what this key adds to them is the two defaults, which `queue:` does not
  // take (`#269`).
  //
  // `claim` reads the plugin since `#269`, and this line is still here: which
  // spelling a file used is `settings.ts`'s one question, and a recipe that
  // declares nothing at `claim` is selected on exactly these three.
  //
  // The fourth is `assignee`, and it is deliberately not here: its v1 spelling
  // is `runtime.assignee` below, on the machine's own file (0046 §3), and a
  // `source.assignee` nothing reads would be a key accepted and dropped.
  source: z.object(SOURCE_FIELDS),

  /**
   * What the run cannot proceed without.
   *
   * **Strict, for the reason `StepMap` is.** This was `allow` — an allowlist,
   * meaning "plant these if they happen to exist" — and that meaning cost $0.97
   * and ten turns against a database the agent could not reach, with one log
   * line as the only sign. A repository naming a variable is a repository saying
   * it needs one ([0020](../../../doc/decisions/0020-the-agent-environment-in-layers.md)).
   * A recipe still saying `allow:` must therefore fail to resolve and name the
   * key, rather than resolve to an empty list and refuse nothing — the same
   * silent half-move [0018](../../../doc/decisions/0018-the-proposed-point.md)
   * made zod's default drop.
   */
  env: z.strictObject({
    /**
     * If present, **only** these names reach the agent.
     *
     * Back in the schema since `#60`, with the meaning it never had before: a
     * filter over data that already exists, not a list of names to go looking
     * for in the process environment. Absent and empty are different — absent
     * means "no allowlist", `[]` means "nothing passes" — which is why this is
     * `optional` and not `.default([])`.
     */
    allow: z.array(z.string()).optional(),
    /** If present, these names do not reach the agent, whatever `allow` says. */
    deny: z.array(z.string()).default([]),
    /**
     * Variable NAMES only. Values resolve at runtime from somewhere the agent
     * cannot see, so this file is safe to commit.
     *
     * **A check, not a filter** ([0021](../../../doc/decisions/0021-the-recipe-decides-the-environment.md)).
     * It is evaluated against the merged data, before `allow`/`deny` apply, so a
     * name that is both `required` and `deny`ed is legal and says two true
     * things: this machine must be configured with it, and this run does not
     * need to see it.
     */
    required: z.array(z.string()).default([]),
    /**
     * Host segments that refuse a value outright — production host patterns,
     * and the field `agent-env`'s tripwire said it was waiting for.
     *
     * **Added to `prod` and `production`, never in place of them**
     * (`productionPatterns`): this file is one the governed agent can edit, and
     * a field that could drop `prod` would let that edit turn the tripwire off.
     * (0005's "add strictness, never remove it" is not the ground: 0016
     * withdrew it.) Those two are inert on a managed database named by a random ref
     * (`#51`), so a repository
     * whose production host is `db.<ref>.supabase.co` names `<ref>` here. That
     * puts an identifier — not a credential — in a committed file, and it is
     * meant to: a reviewer sees the host being refused.
     *
     * Checked before the claim against every value that reaches the agent or an
     * extension, from either file: the agent's by `resolveAgentEnv`, after
     * `allow`/`deny`, and each extension's declared names by `extensionEnv`,
     * which reads them before `deny` — both in `runOnce`, at stage `env`, and
     * both in `lingtai doctor` (`env: <project>`, `env: <project> extensions`).
     *
     * An entry is a segment or a run of them — `<ref>`, `prod-db`, or a whole
     * host — matched segment by segment against a URL's hostname. One that
     * could never equal a run of a hostname's segments is refused here rather
     * than shown to a reviewer as a host being refused: an empty segment
     * (`.supabase.co`), and anything a hostname does not hold — a port
     * (`db.<ref>.supabase.co:5432`), a scheme (`postgresql://…`), a user, a path.
     */
    refuseHosts: z
      .array(
        z
          .string()
          .regex(
            /^[a-z0-9_]+(?:[.\-][a-z0-9_]+)*$/i,
            "a host, or segments of one — no port, scheme, user or path, and no empty segment",
          ),
      )
      .default([]),
    /** Where the filtered env file is planted inside the worktree. Rarely the
     *  repo root — Next/Prisma/vitest read it from the app directory. */
    plantAt: z.string(),
  }),

  // Spelled out rather than `.default({})`: all ten steps exist whether or
  // not a recipe mentions them, and writing that here says so once. 0061 §5 is
  // this line — the file may omit a step, the resolved recipe may not.
  steps: StepMap.default({
    claim: [],
    admit: [],
    prepared: [],
    design: [],
    implement: [],
    build: [],
    review: [],
    proposed: [],
    merge: [],
    end: [],
  }),

  /**
   * Who is told what happened, and about which events.
   *
   * Here rather than in the daemon because **which events are worth telling
   * somebody about is a fact about a channel, not about Lingtai.**
   * `DEFAULT_SUBSCRIPTIONS` was four types in `packages/daemon/src/notify.ts`,
   * the same for every project, changeable only by editing the daemon — and it
   * was four *because it was a desktop notification*, which interrupts. A
   * landed task is not worth interrupting for and is worth a Telegram message,
   * and only a per-channel list can say both. That is 0016 §7's argument again:
   * the repository knows which of its outcomes it wants to hear about and the
   * core cannot see it.
   *
   * It is gone since `#123`, and this is the whole of what replaced it: the
   * desktop notification is `node apps/cli/src/notify.ts` under Lingtai's own
   * `subscribers:`, started by the same code that starts
   * `node packages/telegram/src/cli.ts` beside it (`#125`). There is no list in the daemon to fall back to, which
   * is what makes the paragraph below true rather than decorative.
   *
   * Defaulted to empty rather than optional, like `steps`: a project that
   * declares no subscriber has *declared none*, which is a thing that can be
   * rendered, rather than an absence.
   */
  subscribers: z.array(Subscriber).default([]),

  runtime: z.object({
    agent: RuntimeId.default("claude-code"),
    /**
     * How contained the runtime must be. `conduct.ts` refuses to dispatch when the
     * runtime cannot meet it, which is the whole of the enforcement.
     *
     * Defaulted rather than optional: nothing sits underneath it to fall back
     * to, so an absent tier meaning "unspecified" would be a run whose
     * containment nothing states. `guarded` is what every
     * run has actually used ([ADR 0007](../../../doc/decisions/0007-dual-runtime.md)).
     */
    tier: Tier.default("guarded"),
    prompt: z.string().optional(),
    /**
     * What one pass may spend, as one block
     * ([0039](../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md) §3).
     *
     * `turns` and `wall` bound **one agent run**; `rounds` bounds **how many of
     * them a pass may buy**; `restarts` bounds **how many passes one ticket may
     * buy** (0040). Keeping all four here rather than in sections of their own
     * is the decision, not tidiness: what a ticket costs is then
     * `(restarts + 1) × (rounds + 1) × wall`, readable without leaving the
     * block. On 2026-09-10 the drain told an operator it would wait at most one
     * `wall`, which the fix loop had already made false — a sentence in one file
     * chasing a number kept in another. Four numbers in one place cannot drift
     * apart like that, and `passCeiling` is the one function that multiplies
     * them, so nothing else writes the product down.
     */
    limits: z
      .object({
        turns: z.number().int().positive().default(300),
        /**
         * A duration, checked here for the reason `source.backoff` is checked
         * where it is written: `parseDuration` throws, and a throw out of the
         * middle of something *reading* the resolved recipe names neither the
         * key nor the file. `wall: "90"` — the unit forgotten — resolved
         * cleanly and threw later inside the board's reading of it, where it
         * was read as *the recipe could not be read* (#218).
         */
        wall: z
          .string()
          .default("2h")
          .refine((text) => positiveDuration(text), { message: "must be a positive duration, like 2h" }),
        /**
         * How many times a pass sends the agent back, carrying what refused it.
         *
         * **Two by default, and the number has an argument.** 0025 §3's rule for
         * a spending default is *the smallest number that makes the feature
         * exist*, which would say one — but this key replaces two ceilings that
         * were one each, and 0038 §4's reason for splitting them was real: a
         * build going red and a review refusing are different failures, and a
         * single round shared between them means whichever happens first decides
         * whether the other gets an attempt at all. That is the race 0038 called
         * *not a budget*. A pass that fixes a red build and then meets a finding
         * needs two rounds to do what two purses of one used to do, so two is
         * the smallest number that does not quietly take the feature away.
         *
         * Zero is legal and means **every refusal goes straight to a person** —
         * what `repair.on: false` used to say, now said in the block where the
         * other limits are. A boolean beside a count whose zero already means
         * the same thing is a redundant pair (0039 §4).
         *
         * **And it is the only number a refusal spends against** (`#143`). It
         * was read twice for a while: once here, for a round inside the pass,
         * and once by `decideRepair` for a whole new run the merge lane bought
         * — one key naming two extents, which is what `#141` left behind and
         * 0039 §Consequences says should not exist. The second reading is gone
         * with the purchase, so `rounds` means one thing: how many times a
         * **pass** sends the agent back.
         *
         * Lingtai's *own* failures never reach it, in code (`whoseFailure`): no
         * recipe can make an agent able to fix a database it cannot reach.
         */
        rounds: z.number().int().nonnegative().default(2),
        /**
         * How many times a spent `rounds` ceiling starts the work over instead
         * of asking a person — a fresh pass, from a worktree cut off the base.
         *
         * **The breadth half of the pair `rounds` is the depth half of**
         * ([0040](../../../doc/decisions/0040-rounds-bound-depth-restarts-bound-breadth.md)).
         * A round buys another attempt at *this* approach; a restart buys
         * another approach. When the approach is the defect, no value of
         * `rounds` reaches the fix — which is what
         * [experiment 011](../../../doc/experiments/011-patching-versus-starting-over.md)
         * measured: `#144` patched across two rounds refused three times, cost
         * ~$12 and landed nothing, while the same ticket started over carrying
         * those findings passed first read for $6.56, using none of the ten
         * rounds it had. Each refusal in the first arm was about the code the
         * round before it had written.
         *
         * **Zero by default, and zero is today's behaviour**: a pass whose
         * rounds are spent asks a person, exactly as it did before this key
         * existed. That is 0040 §4 and it is the whole of why this is a key
         * rather than a change — the evidence is one ticket, and no second
         * restart has ever been observed.
         *
         * 0025 §3's rule for a spending default — *the smallest number that
         * makes the feature exist* — would say one, and it does not apply here.
         * That rule is about not taking a feature away by defaulting it too
         * low; this default takes nothing away, because until a project writes
         * a number down there is no feature to take. Turning it on for every
         * project on the strength of n = 1 is the thing being avoided.
         *
         * Only a **judgement** is answered this way, in code and not by recipe:
         * a red build and a conflict stay in the worktree, because for those
         * *the work is still there* is a fact rather than an assumption
         * (0039 §2). See `decideRestart`.
         */
        restarts: z.number().int().nonnegative().default(0),
      })
      .default({ turns: 300, wall: "2h", rounds: 2, restarts: 0 }),
    /**
     * Which issues this machine takes, by their assignee
     * ([0046](../../../doc/decisions/0046-lingtai-is-personal.md) §2, #181).
     *
     * **This is `queue:`'s `assignee` field under its v1 name**
     * ([0063](../../../doc/decisions/0063-every-setting-is-the-recipes.md) §3),
     * and `assigneeOf` in `settings.ts` is what every reader asks. 0063 §3
     * settles that it is one of the four settings that decide which ticket is
     * taken rather than a plugin beside them; §4 is what moves where a person
     * writes it, and that has not happened.
     *
     * **The machine's, never the recipe file's** until it does:
     * `resolveLocalRecipe` puts it here from `~/.lingtai/config.yml` and
     * refuses it written in the recipe, as it does `agent` and `limits`.
     *
     * **Optional, and absent is `both`** — every ticket, assigned or not, which
     * is how the queue behaved before an assignee was read and what somebody
     * working alone expects. Optional rather than defaulted so that a recipe
     * that says nothing hashes and emits exactly as it did.
     */
    assignee: AssigneeRule.optional(),
    /**
     * How much an agent is told, in characters and rows
     * ([0029](../../../doc/decisions/0029-the-prompt-budget-is-the-recipes.md)).
     *
     * `limits` bounds what a run may *spend*; this bounds what it is *given*,
     * and the two are the same kind of decision — which is why they sit
     * together. Four numbers decided the answer to "what does an agent know
     * about why the last attempt failed" (`#82`, `#84`) from four constants in
     * two packages that nobody reviewed together, and prompt content is the
     * most expensive lever this system has.
     *
     * Here rather than compiled in for the reason `backoff` and `repair` are
     * (0016 §7): how much of a failure is worth quoting depends on what this
     * repository's failures look like — a build that prints one line and a
     * suite that prints two hundred do not want the same budget — and that is a
     * thing the repository knows and the core cannot see.
     *
     * The defaults are the constants they replaced, unchanged, so a recipe that
     * says nothing renders exactly the prompt it rendered before.
     */
    budget: z
      .object({
        /** Characters of one earlier failure's output quoted verbatim into the next prompt. */
        evidence: z.number().int().positive().default(2_000),
        /** Rows the attempt table names before it says "and N earlier". */
        attempts: z.number().int().positive().default(5),
        /** Findings of a review gate carried into the next attempt. */
        findings: z.number().int().positive().default(5),
        /**
         * Bytes of the diff a review agent sees before it is truncated.
         *
         * [Experiment 001](../../../doc/experiments/001-cold-review-issue-58.md)'s
         * diff was 1391 lines across 6 files and fitted comfortably. Far past
         * that is a work item scoped too large, which the compaction counter
         * already reports; sending a megabyte produces a worse review, not a
         * better one.
         */
        diff: z.number().int().positive().default(400_000),
      })
      .default({ evidence: 2_000, attempts: 5, findings: 5, diff: 400_000 }),
  }),
});
export type Recipe = z.infer<typeof Recipe>;

export { formatDuration, parseDuration } from "./duration.ts";

/**
 * What a recipe that says nothing about limits gets.
 *
 * Exported so that a sentence about the default can be **generated from the
 * default** — `apps/cli`'s drain names a number it cannot read from any one
 * project's recipe, and naming it by hand is how it came to say one `wall` when
 * the fix loop had already made that false.
 */
export const LIMIT_DEFAULTS = Recipe.shape.runtime.shape.limits.parse(undefined);

/**
 * `parseDuration`, as a predicate: for a schema, where throwing is the wrong
 * shape.
 *
 * Exported for the machine file's schema, which holds the same `wall` this one
 * does and must refuse the same values by name (0046 §3, #218).
 */
export function positiveDuration(text: string): boolean {
  try {
    return parseDuration(text) > 0;
  } catch {
    return false;
  }
}
