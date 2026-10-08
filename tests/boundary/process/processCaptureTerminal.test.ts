import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { itWithCaptureCapability } from "./processCaptureCapability.js";

import { captureProcessScenario } from "../../../src/process/capture/ProcessHarness.js";
import { parseProcessScenario } from "../../../src/domain/process/processCapture.js";

itWithCaptureCapability(
  "captures one command's terminal output, selected files, and owned cleanup",
  async () => {
    const root = await createTestTempDirectory("rea-process-capture-");
    const script = join(root, "task.mjs");
    await writeFile(
      script,
      [
        'import { writeFile } from "node:fs/promises";',
        "process.stdout.write(`value:${process.env.CAPTURE_VALUE}\\n`);",
        'await writeFile("state.txt", "created");',
      ].join("\n"),
    );
    try {
      const result = await captureProcessScenario(
        parseProcessScenario({
          executable: process.execPath,
          arguments: [script],
          working_directory: root,
          environment: { CAPTURE_VALUE: "caller-selected" },
          filesystem_observation_paths: ["."],
        }),
      );
      if (!result.ok) throw result.error;
      expect(result.value.frames.map(({ data }) => data).join("")).toContain(
        "value:caller-selected",
      );
      expect(result.value.files_after).toContainEqual(
        expect.objectContaining({ path: "root_0:state.txt" }),
      );
      expect(result.value.filesystem_effects).toContainEqual(
        expect.objectContaining({
          status: "created",
          path: "root_0:state.txt",
        }),
      );
      expect(result.value.cleanup).toMatchObject({
        owned_process_group: "verified",
        temporary_root: "removed",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);
