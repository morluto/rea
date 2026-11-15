/**
 * Import this checkout's verifier source without starting a compiler process.
 * A relative `.js` or `.mjs` specifier from owned source falls back to its
 * TypeScript source.
 */
export function importVerifierSource(
  url: string,
  parent: string,
): Promise<Record<string, unknown>>;

/** TypeScript source a missing `.js` or `.mjs` specifier names, as this loader resolves it. */
export function typeScriptSourcePath(path: string): string | undefined;
