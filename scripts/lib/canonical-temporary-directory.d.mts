/** Allocate under a caller-selected parent and return the host's canonical spelling. */
export declare const createCanonicalTemporaryDirectory: (
  prefix: string,
  parent?: string,
) => Promise<{ readonly path: string; readonly allocatedPath: string }>;
