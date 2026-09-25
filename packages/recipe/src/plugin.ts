/**
 * **The plugin contract**: one shape every plugin implements, and the core
 * calls it once — when the recipe resolves, before a work item is claimed
 * ([0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §9).
 *
 * This file knows *what a plugin is*. It does not know which plugins exist:
 * the closed set is `PLUGINS` in `recipe.ts`, beside the twelve declarations, and
 * every function here takes the set it is to work against. That is the whole of
 * the separation — **a plugin owns its schema, and a second copy of that
 * knowledge would be a second thing to keep true**, so there is no registry of
 * fields anywhere, here or there.
 *
 * ## What a plugin declares
 *
 * Ansible's `argument_spec`, and the parts worth taking are its parts: type,
 * required, default, choices, and cross-field constraints *inside one plugin*.
 * A field is a zod schema, so all five are things the plugin already says in the
 * one place it is declared. What is **not** taken is Ansible's second source of
 * truth — a module carries `argument_spec` for the machine and a
 * `DOCUMENTATION` block for the reader, kept aligned by a sanity test. Here
 * **the schema is the documentation**, and the JSDoc beside a field is on the
 * field rather than in a second block about it.
 *
 * ## `env:` is a field, not a universal key
 *
 * *Which credentials do I need* is the one question only the plugin can answer,
 * and a universal key is by definition something the workflow imposes without
 * asking. So `env:` is declared by the plugins that spawn a process
 * ([0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §1: *an
 * extension's declaration is the whole of what its process gets*), and a recipe
 * that writes one under a plugin that spawns nothing is **refused by name**
 * rather than having the field silently accepted and ignored. That refusal is
 * only possible because the field belongs to the plugin — which is why the
 * schema below is strict and the union it used to sit in was not.
 *
 * **`name` is the one key this file adds**, because it is genuinely the
 * workflow's: every action is addressed by it — `task_view` keys a verdict
 * `step:action`, the board draws it, `lingtai waive` names it — and no plugin
 * decides that. 0061 §2 makes `when:` and `timeout:` universal too, and they
 * are **not** hoisted here: today `when:` is legal on four plugins and
 * `timeout:` on one, and hoisting either would make it legal on all twelve.
 * That is a behavioural change, and this is not the ticket for it — and the
 * four are not one key wearing one spelling: `close:` and `labels:` read the
 * work item's *outcome* (`WHEN`), `refs:` reads the one value of it that is
 * safe to delete a ref on and refuses the rest (`#240`), and `judge:` reads
 * the *reason the last step gave* (`JudgeWhen`, `#238`) — so a hoist has two
 * vocabularies and a narrowing to reconcile before it has one universal key,
 * and hoisting `WHEN` would hand `refs:` back the values its own schema exists
 * to refuse. The counts here are counted off `PLUGINS`
 * by `packages/recipe/unit/plugin.test.ts` rather than remembered.
 *
 * ## `no_log`
 *
 * This repository already has the rule — *names only, never values* — in
 * `extensionRow`, in the agent's row, in `lingtai env set`'s unechoed stdin.
 * Today it is a rule people remember. `noLog` makes it mechanical: a field
 * marked in a plugin's schema has its **value** replaced by a digest of itself
 * — `withheld` below — before an action reaches the log, the hash over it, the
 * board, or a refusal's text, and every one of those learns it from the one
 * declaration.
 *
 * **A stand-in and not a deletion**, because `configHash` is the identity of a
 * document ([0047](../../../doc/decisions/0047-the-recipe-a-run-got-is-on-the-log.md)
 * §2: *two documents with one hash are one document*). A field deleted before
 * the digest is taken would make two recipes that differ in a credential hash
 * the same, and the task page settles *is this the recipe at head* by that hash
 * alone — so rotating a token would leave the board telling an operator the run
 * used the document head has when it used another. The value comes out; that
 * the field was there, and that it has changed, stays.
 *
 * **A mark that could not be honoured is refused where it is written**, and
 * there are two of those. `definePlugin` throws on either, at import, so a
 * declaration that reads as marked and strips nothing never gets as far as a
 * recipe:
 *
 * - **Below the field's own schema.** The mark is read off each field with
 *   `.meta()`, and zod keeps meta on the instance `noLog` was called on — so
 *   `z.object({ token: noLog(z.string()) })` and `noLog(z.string()).optional()`
 *   are both marks nothing will ever read. Refused rather than walked for,
 *   because `disclose` withholds whole fields: honouring a mark inside a nested
 *   object would mean a second mechanism, and this one has to be the only one
 *   there is.
 * - **On what names the action.** The key carries what the plugin *runs* —
 *   `run:`'s command, `close:`'s `true` — and `name` is the address: `task_view`
 *   keys a verdict `step:action`, `lingtai waive` names one, the board draws
 *   it. A stand-in in either place leaves an action nobody can name: the log
 *   would record that something ran without saying what, a waiver would address
 *   a digest, and `close: true` would read as a string its own schema refuses.
 *   A secret goes in a field *beside* the key, never on it.
 *
 * **Three honest limits, so none is a silent hole.** The first is the recipe
 * file's own bytes: the board renders `recipe.source` verbatim, so a value
 * *written in the file* is on the screen whatever any schema says — which is
 * why the standing rule is that the file holds names and the values resolve
 * from somewhere the agent cannot see
 * ([0021](../../../doc/decisions/0021-the-recipe-decides-the-environment.md)).
 * The second is the plugin's own output: a command that echoes its own
 * credential puts it in the evidence, and no declaration upstream of the spawn
 * can reach that. The third is `withheld`'s own idempotence, below: a value
 * that is *itself* written as a stand-in is left alone, and so discloses the
 * nothing it already was.
 *
 * **Nothing declares one today**, and that is a fact rather than an oversight:
 * every field the twelve plugins have is a name, a command, a prompt, a runtime,
 * a model, a glob, a
 * branch, a strategy, a label, a flag, a direction, a severity or a GitHub login — and a login is
 * not a credential, which is the distinction worth reading (0046 §2: a wrong
 * one hands this machine somebody else's tickets, and that is a mistake that
 * shows itself). Both numerals in this file are counted off `PLUGINS` by
 * `packages/recipe/unit/plugin.test.ts` rather than remembered, because a claim
 * about *every field of the set* that is sized from a set less than half its
 * size is the one way this sentence goes quietly wrong: the plugins have
 * arrived four and five at a time, and none of those tickets was about `no_log`.
 * The mechanism is here so that the first plugin that needs one gets it from a
 * declaration instead of from a convention, and `unit/plugin.test.ts` drives it
 * over a plugin of its own rather than over an empty set.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

/** A plugin's own fields, by the name a recipe writes them under. */
export type PluginFields = Readonly<Record<string, z.ZodType>>;

/**
 * A field whose **value** never leaves the plugin — Ansible's `no_log`.
 *
 * Marked on the field and read back off it, so there is no list of secret names
 * anywhere to keep true. Apply it last — `noLog(z.string().optional())` and not
 * `noLog(z.string()).optional()`: `.default()` and the other wrappers return a
 * new schema, and the mark sits on the one it is called on. Getting that the
 * wrong way round is one of the two marks `definePlugin` refuses rather than
 * accepts and ignores.
 */
export function noLog<Field extends z.ZodType>(field: Field): Field {
  return field.meta({ no_log: true });
}

/** What a withheld value reads as, and the only string `withheld` ever writes. */
const WITHHELD = "no_log:sha256:";

/**
 * A withheld value's **stand-in**: a digest of it, and never any part of it.
 *
 * Why a digest rather than nothing at all is at the head of this file — a
 * deleted field takes the difference between two documents out of the hash that
 * is their identity (0047 §2). With one, `GatesResolved`'s body still records
 * that the action carried a token, a rotated credential is a `configHash` that
 * changed, and the board's own walk says *this field differs* without saying
 * what it differs to.
 *
 * Twelve hex characters, the length the board already prints a `configHash` at.
 * It is read by a person asking whether two recipes are the same document, and
 * a preimage of it is a credential whoever can ask already holds.
 *
 * **Idempotent, because the body gets hashed again by its readers.**
 * `conductor/unit/recorded-recipe.test.ts` hands `hashRecipe` the body off the
 * event, which has been through here already, so a stand-in has to stand in for
 * itself — and that is the third limit at the head of this file.
 */
export function withheld(value: unknown): string {
  if (typeof value === "string" && value.startsWith(WITHHELD)) return value;
  const of = JSON.stringify(value) ?? "undefined";
  return WITHHELD + createHash("sha256").update(of).digest("hex").slice(0, 12);
}

/**
 * What the disclosure needs of a plugin, which is **less than a plugin**: the
 * key that identifies it in an action, and which of its fields are `no_log`.
 *
 * Narrower than `Plugin` on purpose. A caller proving the strip — the board's
 * own test, which has no reason to depend on zod — needs no schema to do it
 * with, and a function asking for one would be asking for what it does not
 * read.
 */
export interface PluginSecrets {
  readonly key: string;
  readonly secrets: readonly string[];
}

/**
 * One plugin, as everything outside it sees it.
 *
 * `schema` is `z.ZodType` rather than a `ZodObject` on purpose: nothing here
 * reaches inside a plugin's shape, and the two things that would want to —
 * which fields there are, and which of them are secret — are read once, at
 * declaration, and carried as plain strings.
 */
export interface Plugin extends PluginSecrets {
  /** The key that names it in a recipe. Exactly one per action, and it is the discriminator. */
  readonly key: string;
  /** Everything it accepts, and nothing else: strict, so an undeclared field is refused. */
  readonly schema: z.ZodType;
  /** The fields it declares, `name` included, for a refusal that has to list them. */
  readonly declares: readonly string[];
  /** Those of them marked `noLog`. */
  readonly secrets: readonly string[];
}

/**
 * Why this field of this plugin cannot be the withheld one, or `null`.
 *
 * **What names an action is never what a reading of it withholds.** A stand-in
 * in either of these two leaves an object nothing can name, which `disclose`'s
 * own callers then read as something it is not — so the answer is a refusal and
 * not a best effort. Asked of a declaration by `definePlugin` and of a
 * `PluginSecrets` by `disclose`, because the second is written by hand in places
 * that have no schema for the first to have checked.
 */
function whyItCannotBeWithheld(key: string, field: string): string | null {
  if (field === key) return "that key is the one word saying which plugin an action is";
  if (field === "name") return "that is the name every verdict, waiver and reading addresses it by";
  return null;
}

/** The refusal a mark that cannot be honoured gets, in the one wording both raise. */
function markRefused(key: string, field: string, why: string): Error {
  return new Error(
    `"${key}" marks its own "${field}" field no_log, and ${why}. A no_log field goes beside the key ` +
      "rather than on it, so that what ran is still on the log and only the value is not (0061 §9)",
  );
}

/**
 * Whether anything *below* this schema carries the mark — a mark on a schema no
 * field is, and so one nothing reads.
 *
 * The walk is over zod's own `_zod.def` and is generic on purpose: an object's
 * `shape`, an array's `element`, a wrapper's `innerType` and a union's `options`
 * are all schemas sitting somewhere under a def, and enumerating the shapes zod
 * has would be a list to keep true — which is what this file exists not to
 * have. `seen` is for the cycle a recursive schema has; a `z.lazy` getter is a
 * function and is walked past, so a mark reached only through one is missed —
 * the refusal is a guard against the mistake somebody makes writing a
 * declaration, not a proof about every schema zod can build.
 */
function markedBelow(schema: z.ZodType): boolean {
  const seen = new Set<object>();
  const walk = (value: unknown, own: boolean): boolean => {
    if (typeof value !== "object" || value === null || seen.has(value)) return false;
    seen.add(value);
    if (isSchema(value)) {
      if (!own && value.meta()?.["no_log"] === true) return true;
      return walk(value._zod.def, false);
    }
    return Object.values(value).some((each) => walk(each, false));
  };
  return walk(schema, true);
}

/** A schema, told apart from the defs and checks the walk above also meets. */
function isSchema(value: object): value is z.ZodType {
  return "_zod" in value && typeof (value as { meta?: unknown }).meta === "function";
}

/**
 * A plugin, from its key and the fields it declares.
 *
 * The strictness is the contract's rather than each plugin's, because *refuse a
 * field you do not understand* is the rule all of them are held to (0061 §9)
 * and a plugin that forgot to say `strictObject` would be the one that accepts
 * `env:` and drops it.
 *
 * **It throws on a `no_log` mark it could not honour**, rather than answering a
 * plugin whose `secrets` is quietly shorter than its author wrote — see the two
 * cases at the head of this file. A declaration is code, so the throw is at
 * import: there is no recipe, no worktree and nothing claimed to be halfway
 * through.
 */
export function definePlugin<Key extends string, Fields extends PluginFields>(key: Key, fields: Fields) {
  const shape = { name: z.string(), ...fields };
  const secrets: string[] = [];
  for (const [field, schema] of Object.entries(fields)) {
    if (schema.meta()?.["no_log"] !== true) {
      if (markedBelow(schema))
        throw new Error(
          `"${key}" marks no_log below its "${field}" field, where nothing reads it: zod keeps the mark ` +
            "on the schema noLog was called on, and disclose withholds whole fields. Mark the field " +
            "itself, and mark it last — noLog(z.string().optional()), never noLog(z.string()).optional()",
        );
      continue;
    }
    const why = whyItCannotBeWithheld(key, field);
    if (why !== null) throw markRefused(key, field, why);
    secrets.push(field);
  }
  return { key, schema: z.strictObject(shape), declares: Object.keys(shape), secrets };
}

/**
 * The plugin an action names, or `null` when it names none or more than one.
 *
 * The discriminator is *which key is present*, which zod cannot switch on — so
 * this is asked before the schema is, and that is the whole reason a bad field
 * can be reported against the plugin that owns it rather than as a union's
 * "invalid input".
 */
export function pluginNaming<Known extends { key: string }>(
  action: unknown,
  plugins: readonly Known[],
): Known | null {
  const named = pluginsNamed(action, plugins);
  return named.length === 1 ? named[0]! : null;
}

/** Every plugin an action names, for a refusal that has to say which two. */
export function pluginsNamed<Known extends { key: string }>(
  action: unknown,
  plugins: readonly Known[],
): Known[] {
  if (action === null || typeof action !== "object") return [];
  return plugins.filter((plugin) => plugin.key in action);
}

/** One thing wrong with one action's fields. */
export interface FieldProblem {
  /** The field it is about, or `null` where the problem is the action's shape. */
  readonly field: string | null;
  /** Where it sits under the action, so an issue's path reads `proposed.0.env`. */
  readonly at: readonly PropertyKey[];
  /** What is wrong, in the plugin's own words — and never the value. */
  readonly why: string;
}

/**
 * One plugin's own validation: the action as it accepts it, or **every** field
 * it refuses.
 *
 * Every problem rather than the first, because a resolve that stops at the
 * first bad field makes a person fix one thing per attempt — which is
 * [#222](https://github.com/steven-zhc/lingtai/issues/222)'s lesson about the
 * build step applied to configuration. The caller adds the step and the action
 * to each sentence; what is here is the half only the plugin knows.
 */
export function readFields(
  plugin: Plugin,
  action: unknown,
): { value: unknown; problems?: undefined } | { value?: undefined; problems: FieldProblem[] } {
  const parsed = plugin.schema.safeParse(action);
  if (parsed.success) return { value: parsed.data };

  const problems: FieldProblem[] = [];
  for (const issue of parsed.error.issues) {
    // `path` is empty for the plugin's own fields and not for a key inside one
    // of them — `worktree: { bse: main }` is an unrecognized key at
    // `["worktree"]`. Only the first is this plugin's field list, so a nested
    // one takes the branch below and gets zod's own words about the object it
    // is in; listing `declares` there would name the plugin's fields at a depth
    // where none of them is legal, which is a refusal that sends a reader to
    // the wrong line.
    if (issue.code === "unrecognized_keys" && issue.path.length === 0) {
      // The `env:` case 0061 §9 is written about, and the one a union could
      // never give: the field is named, the plugin is named, and what the
      // plugin does declare is listed beside it.
      for (const key of issue.keys) {
        problems.push({
          field: key,
          at: [key],
          why:
            `"${plugin.key}" declares no "${key}" field — what it declares is ` +
            `${plugin.declares.map((field) => `"${field}"`).join(", ")}. A plugin refuses a field it does ` +
            "not understand, rather than accepting it and ignoring it (0061 §9)",
        });
      }
      continue;
    }
    const field = typeof issue.path[0] === "string" ? issue.path[0] : null;
    problems.push({
      field,
      at: issue.path,
      // A secret field's refusal says which field and stops: zod's own message
      // is about the value, and a refusal is read by whoever the recipe refused.
      why:
        field !== null && plugin.secrets.includes(field)
          ? `its "${field}" field is not what "${plugin.key}" accepts, and this refusal does not say ` +
            "what was written there: the field is declared no_log"
          : `${field === null ? "it" : `its "${field}" field`} is not what "${plugin.key}" accepts: ${issue.message}`,
    });
  }
  return { problems };
}

/**
 * An action as anything outside its own plugin may see it: every `no_log`
 * field's value replaced by `withheld`'s stand-in for it.
 *
 * **The field stays and only its value goes**, which is what keeps an action
 * that carries a credential one document rather than the same document as every
 * other action carrying a different one — see `withheld`, and 0047 §2.
 *
 * A field a recipe did not write is not invented here: an optional secret left
 * out stays out, so a recipe without one hashes as a recipe without one.
 * Returns the action itself where there is nothing to withhold, which is every
 * action today — so the log's bytes, the hash over them and the board's reading
 * are the same as they were before this existed.
 *
 * **It throws rather than withhold what names the action.** `definePlugin`
 * refuses such a declaration, and a `PluginSecrets` is the shape that is written
 * by hand — by a test outside this package, which has no schema to have been
 * refused — so the same rule is asked here, where the substitution would happen.
 * Answering the altered object instead would be the quiet failure the whole mark
 * exists to remove, one layer further down.
 */
export function disclose<Action>(action: Action, plugins: readonly PluginSecrets[]): Action {
  const plugin = pluginNaming(action, plugins);
  if (plugin === null || plugin.secrets.length === 0) return action;
  const shown = { ...(action as object) } as Record<string, unknown>;
  for (const field of plugin.secrets) {
    const why = whyItCannotBeWithheld(plugin.key, field);
    if (why !== null) throw markRefused(plugin.key, field, why);
    if (!(field in shown)) continue;
    shown[field] = withheld(shown[field]);
  }
  return shown as Action;
}
