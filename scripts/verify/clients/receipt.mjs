import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withVerifierCleanup } from "../../lib/verifier-cleanup.mjs";

/**
 * @param {string} artifacts
 * @param {string} runtimeRoot
 */
export const receiptContext = (artifacts, runtimeRoot) => ({
  artifacts,
  runtimeRoot,
  host: {
    platform: process.platform,
    architecture: process.arch,
    node: process.versions.node,
  },
});

/**
 * Emit the machine-readable receipt even when saving its readable copy fails.
 * @param {{ artifacts: string }} receipt
 */
export const publishReceipt = (receipt) =>
  withVerifierCleanup(
    () =>
      writeFile(
        join(receipt.artifacts, "receipt.json"),
        JSON.stringify(receipt, null, 2),
      ),
    [() => console.log(JSON.stringify(receipt))],
  );
