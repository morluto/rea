import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ExecFileOutputCancelledError } from "../process/ExecFileOutput.js";
import { LinuxHopperPublisher } from "./LinuxHopperPublisher.js";

it.each(["physical", "caller", "node-wrapper", "producer"] as const)(
  "attributes package-family observation failure after hashing (%s)",
  async (kind) => {
    const root = await createTestTempDirectory("rea-publisher-cancellation-");
    const path = join(root, "inert-launcher");
    await writeFile(path, "inert launcher bytes");
    const controller = new AbortController();
    const reason = { caller: "stop inspection" };
    const physical = new Error("distribution inspection failed");
    const wrapped = Object.assign(
      new Error("operation aborted", { cause: reason }),
      {
        name: "AbortError",
        code: "ABORT_ERR",
      },
    );
    const publisher = new LinuxHopperPublisher({ HOME: root }, async () => {
      if (kind !== "producer") controller.abort(reason);
      throw kind === "physical"
        ? physical
        : kind === "caller"
          ? reason
          : kind === "node-wrapper"
            ? wrapped
            : new ExecFileOutputCancelledError(reason);
    });
    try {
      const result = await publisher.inspectLauncher(path, controller.signal);
      expect(result).toMatchObject({
        ok: false,
        error: {
          reason:
            kind === "physical" ? "verification_unavailable" : "cancelled",
        },
      });
      if (result.ok) throw new Error("Expected failed observation");
      expect(result.error.cause).toBe(kind === "physical" ? physical : reason);
    } finally {
      await publisher.close();
    }
  },
);
