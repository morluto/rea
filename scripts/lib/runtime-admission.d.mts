/** True when `version` is a release admitted by an `engines.node` range. */
export function satisfiesNodeRange(range: string, version: string): boolean;

/** Refusal text for a release outside `range`, or undefined when it is admitted. */
export function unsupportedRuntimeMessage(
  range: string,
  version: string,
): string | undefined;

/** Human-readable release families for an `engines.node` range. */
export function supportedReleaseProse(range: string): string;
