import { join } from "node:path";

import { expect, it } from "vitest";

import {
  EDITED_NOTE,
  seedEndCapture,
  writeCaptureFolder,
} from "../../../src/application/desktop/desktopCapture.fixture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { serveCli as serve } from "./cliServeHarness.js";

it("exports and drafts between the checkpoints the command names", async () => {
  const capture = await writeCaptureFolder(seedEndCapture(), undefined, [
    EDITED_NOTE,
  ]);
  const ends = ["--seed-checkpoint", "seed", "--end-checkpoint", "end"];
  const bundle = join(await createTestTempDirectory("desktop-cli-"), "bundle");

  const exported = await serve([
    "export-desktop-application",
    capture,
    bundle,
    ...ends,
    "--json",
  ]);
  const drafted = await serve([
    "describe-desktop-application-task",
    capture,
    ...ends,
    "--json",
  ]);
  const refused = await serve([
    "describe-desktop-application-task",
    capture,
    "--end-checkpoint",
    "saved",
    "--json",
  ]);

  expect(
    parseEvidence(JSON.parse(exported.stdout)).normalized_result,
  ).toMatchObject({
    checkpoints: { seed: "seed", end: "end" },
    seed_files: [".config/notes/settings.ini", "Documents/today.txt"],
  });
  expect(
    parseEvidence(JSON.parse(drafted.stdout)).normalized_result,
  ).toMatchObject({ checkpoints: { baseline: "seed", final: "end" } });
  expect(JSON.parse(refused.stdout)).toMatchObject({
    code: "invalid_request",
    details: {
      operation: "describe_desktop_application_task",
      issues: [{ path: ["end_checkpoint"] }],
    },
  });
});

it.each([
  [["--exclude", ""], "exclude"],
  [["--state-path", ""], "statePath"],
  [["--output", ""], "output"],
])(
  "refuses an empty path selection %j before it can name the current directory",
  async (option, field) => {
    const result = await serve([
      "capture-desktop-application",
      "--executable",
      "notes",
      "--output",
      "capture",
      ...option,
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [
        expect.objectContaining({ path: expect.stringContaining(field) }),
      ],
    });
  },
);
