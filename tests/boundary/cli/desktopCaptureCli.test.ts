import { readFile } from "node:fs/promises";
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

it("installs the packages each --extra-package names beside the app, and refuses a name that is not a package's", async () => {
  const capture = await writeCaptureFolder(seedEndCapture(), undefined, [
    EDITED_NOTE,
  ]);
  const root = await createTestTempDirectory("desktop-cli-");
  const extra = (bundle: string, ...names: string[]) =>
    serve([
      "export-desktop-application",
      capture,
      join(root, bundle),
      ...names.flatMap((name) => ["--extra-package", name]),
      "--json",
    ]);

  const exported = parseEvidence(
    JSON.parse(
      (await extra("bundle", "librsvg2-common", "openjdk-17-jre")).stdout,
    ),
  );
  const refused = await extra("refused", "librsvg2-common", "Java 17");

  expect(exported.parameters).toMatchObject({
    extra_packages: ["librsvg2-common", "openjdk-17-jre"],
  });
  expect(
    await readFile(join(root, "bundle/envs/notes/notes_app.py"), "utf8"),
  ).toContain(
    'packages=Packages(apt=["notes", "librsvg2-common", "openjdk-17-jre"])',
  );
  const named = (text: string) =>
    text.includes("librsvg2-common") && text.includes("openjdk-17-jre");
  expect(exported.limitations.filter(named)).toHaveLength(1);
  expect(named(await readFile(join(root, "bundle/README.md"), "utf8"))).toBe(
    true,
  );
  expect(JSON.parse(refused.stdout)).toMatchObject({
    code: "invalid_request",
    details: { issues: [{ path: ["extra_package"] }] },
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
