import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { readReferenceSource } from "../../../src/reference/ReferenceSourceReader.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("reports cancellation when the final excluded entry cancels traversal", async () => {
  const root = await createTestTempDirectory("rea-reference-cancel-");
  await writeFile(join(root, "excluded.txt"), "caller-selected exclusion");
  const controller = new AbortController();
  const result = await readReferenceSource(root, {
    signal: controller.signal,
    shouldExclude: () => {
      controller.abort();
      return true;
    },
  });
  expect(result).toMatchObject({ ok: false, error: { code: "cancelled" } });
});
