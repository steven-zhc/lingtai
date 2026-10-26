/** `lingtai env`'s usage, apart from `env.ts` so `cli.ts` can print it without loading `@lingtai/agent-env` (#625). */
export const USAGE = `lingtai env set <project> KEY=VALUE   write or replace one value
lingtai env set <project> KEY         read the value from stdin, unechoed
lingtai env list <project>            names and where each came from
lingtai env unset <project> KEY       remove one`
