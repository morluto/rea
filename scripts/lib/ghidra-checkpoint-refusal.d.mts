/** Require the CLI's explicit refusal instead of accepting an unrelated failure. */
export function requireCheckpointCliRefusal(
  operation: () => Promise<unknown>,
  expectedCode: string,
): Promise<{ readonly code: string; readonly [key: string]: unknown }>;

/** Verify refusal before the caller restores its deliberately invalid manifest. */
export function assertCheckpointRefusalPreservesManifest(
  operation: () => Promise<unknown>,
  manifestPath: string,
  expectedBytes: Uint8Array,
): Promise<{ readonly code: string; readonly [key: string]: unknown }>;
