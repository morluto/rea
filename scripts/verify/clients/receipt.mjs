import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withVerifierCleanup } from "../../lib/verifier-cleanup.mjs";

/** Emit the machine-readable receipt even when saving its readable copy fails. */
export const publishClientReceipt = (lab, receipt) =>
  withVerifierCleanup(
    () =>
      writeFile(join(lab, "receipt.json"), JSON.stringify(receipt, null, 2)),
    [() => console.log(JSON.stringify(receipt))],
  );
