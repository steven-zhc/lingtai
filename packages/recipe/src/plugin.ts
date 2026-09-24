/**
 * **The plugin contract**: one shape every plugin implements, and the core
 * calls it once — when the recipe resolves, before a work item is claimed
 * ([0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §9).
 *
 * This file knows *what a plugin is*. It does not know which plugins exist:
 * the closed set is `PLUGINS` in `recipe.ts`, beside the six declarations, and
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
 * are **not** hoisted here: today `when:` is legal on two plugins and
 * `timeout:` on one, and hoisting either would make it legal on all six. That
 * is a behavioural change, and this is not the ticket for it.
 *
 * ## `no_log`
 *
 * This repository already has the rule — *names only, never values* — in
 * `extensionRow`, in the agent's row, in `lingtai env set`'s unechoed stdin.
 * Today it is a rule people remember. `noLog` makes it mechanical: a field
 * marked in a plugin's schema is stripped by `disclose` before an action
 * reaches the log, the board, or a refusal's text, and every one of those
 * learns it from the one declaration.
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
 *   because `disclose` deletes whole fields: honouring a mark inside a nested
 *   object would mean a second stripping mechanism, and this one has to be the
 *   only one there is.
 * - **On what names the action.** The key is the discriminator `kindOfAction`
 *   switches on, and `name` is the address — `task_view` keys a verdict
 *   `step:action`, `lingtai waive` names one, the board draws it. Stripping
 *   either leaves an action naming no plugin: the log would record that
 *   something ran without saying what, the board would read it as the kind it
 *   falls back to, and two actions differing only in a secret would carry one
 *   digest. A secret goes in a field *beside* the key, never on it.
 *
 * **Two honest limits, so neither is a silent hole.** The first is the recipe
 * file's own bytes: the board renders `recipe.source` verbatim, so a value
 * *written in the file* is on the screen whatever any schema says — which is
 * why the standing rule is that the file holds names and the values resolve
 * from somewhere the agent cannot see
 * ([0021](../../../doc/decisions/0021-the-recipe-decides-the-environment.md)).
 * The second is the plugin's own output: a command that echoes its own
 * credential puts it in the evidence, and no declaration upstream of the spawn
 * can reach that.
 *
 * **Nothing declares one today**, and that is a fact rather than an oversight:
 * every field the six plugins have is a name, a command, a prompt or a glob.
 * The mechanism is here so that the first plugin that needs one gets it from a
 * declaration instead of from a convention, and `unit/plugin.test.ts` drives it
 * over a plugin of its own rather than over an empty set.
 */
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
 * **What names an action is never what a reading of it withholds.** Deleting
 * either of these two leaves an object naming no plugin, which `disclose`'s own
 * callers then read as something it is not — so the answer is a refusal and not
 * a best effort. Asked of a declaration by `definePlugin` and of a
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
            "on the schema noLog was called on, and disclose deletes whole fields. Mark the field " +
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
    if (issue.code === "unrecognized_keys") {
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
 * An action as anything outside its own plugin may see it: every `no_log` field
 * gone.
 *
 * Returns the action itself where there is nothing to strip, which is every
 * action today — so the log's bytes, the hash over them and the board's reading
 * are the same as they were before this existed.
 *
 * **It throws rather than delete what names the action.** `definePlugin` refuses
 * such a declaration, and a `PluginSecrets` is the shape that is written by hand
 * — by a test outside this package, which has no schema to have been refused —
 * so the same rule is asked here, where the deletion would happen. Answering a
 * stripped object instead would be the quiet failure the whole mark exists to
 * remove, one layer further down.
 */
export function disclose<Action>(action: Action, plugins: readonly PluginSecrets[]): Action {
  const plugin = pluginNaming(action, plugins);
  if (plugin === null || plugin.secrets.length === 0) return action;
  const shown = { ...(action as object) } as Record<string, unknown>;
  for (const field of plugin.secrets) {
    const why = whyItCannotBeWithheld(plugin.key, field);
    if (why !== null) throw markRefused(plugin.key, field, why);
    delete shown[field];
  }
  return shown as Action;
}
