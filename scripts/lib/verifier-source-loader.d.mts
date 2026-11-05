/** Remediation shared by every development runtime failure. */
export const DEVELOPMENT_RUNTIME_GUIDANCE: string;

export type DevelopmentRuntimeReason =
  | "register_hooks_unavailable"
  | "strip_typescript_types_unavailable"
  | "transform_mode_unavailable";

/**
 * Thrown when this Node.js runtime cannot load the checkout's TypeScript
 * source. `code` and `reason` are stable facts; the message may change.
 */
export class DevelopmentRuntimeError extends Error {
  readonly code: "ERR_REA_DEVELOPMENT_RUNTIME";
  readonly reason: DevelopmentRuntimeReason;
  readonly runtime: string;
}

/**
 * Import this checkout's verifier source without starting a compiler process.
 */
export function importVerifierSource(
  url: string | URL,
  parent?: string | URL,
): Promise<Record<string, unknown>>;
