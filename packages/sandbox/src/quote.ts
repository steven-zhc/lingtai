/** One argv element as a POSIX single-quoted word: `'` is written `'\''`. */
export const quoteWord = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`

/** An argv as the one command string srt runs under `bash -c`; S4–S6 never quote by hand. */
export const quoteArgv = (argv: readonly string[]): string => argv.map(quoteWord).join(' ')
