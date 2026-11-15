import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { OwnedCommandFailure } from "../../process/OwnedCommand.js";
import type { ProviderProcessSnapshot } from "../../process/ProviderProcess.js";
import { readPwntoolsFailureEvidence } from "./PwntoolsResourceLimits.js";
import { PWNTOOLS_MEMORY_FAILURE_EXIT } from "./PwntoolsRelease.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";

const memoryExit = new OwnedCommandFailure("process", "bridge exited", {
  stdout: { text: "", bytes: 0, observedBytes: 0 },
  stderr: { text: "", bytes: 0, observedBytes: 0 },
  exitCode: PWNTOOLS_MEMORY_FAILURE_EXIT,
  signal: null,
} as ProviderProcessSnapshot);

it.each([
  ["M", { resource: "memory", failure: null }],
  [
    "F",
    {
      resource: null,
      failure:
        "Private bridge failure marker does not match the observed exit status.",
    },
  ],
] as const)(
  "classifies a %s marker beside the memory exit status",
  async (written, marker) => {
    const root = await createTestTempDirectory("rea-pwntools-marker-");
    await writeFile(join(root, "resource.failure"), written);
    const resources = new ArtifactResourceScope();
    try {
      const evidence = await readPwntoolsFailureEvidence(
        memoryExit,
        root,
        resources,
      );
      expect(evidence.marker).toEqual(marker);
    } finally {
      await resources.close();
    }
  },
);
