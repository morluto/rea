/** Import one TypeScript source module relative to a verifier script URL. */
export function importVerifierSource(
  url: string,
  parent: string,
): Promise<Record<string, unknown>>;
