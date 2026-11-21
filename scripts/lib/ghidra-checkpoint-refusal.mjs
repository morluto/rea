import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/** Require the CLI's explicit refusal instead of accepting an unrelated failure. */
export async function requireCheckpointCliRefusal(operation, expectedCode) {
  let refusal;
  try {
    await operation();
  } catch (cause) {
    assert.equal(cause.code, 1, cause.stderr);
    refusal = JSON.parse(cause.stdout);
  }
  assert.ok(refusal, "CLI unexpectedly accepted unavailable checkpoint state");
  assert.equal(refusal.code, expectedCode, JSON.stringify(refusal));
  return refusal;
}

/** Verify refusal before the caller restores its deliberately invalid manifest. */
export async function assertCheckpointRefusalPreservesManifest(
  operation,
  manifestPath,
  expectedBytes,
) {
  const refusal = await requireCheckpointCliRefusal(
    operation,
    "configuration_invalid",
  );
  assert.ok(
    (await readFile(manifestPath)).equals(expectedBytes),
    `Refused CLI command changed the checkpoint manifest: ${manifestPath}`,
  );
  return refusal;
}
