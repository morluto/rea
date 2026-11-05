import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import {
  EDITED_NOTE,
  seedEndCapture,
  writeCaptureFolder,
} from "../../src/application/desktop/desktopCapture.fixture.js";
import { serveCli } from "../boundary/cli/cliServeHarness.js";
import { buildComputerFakes, connectBuildServer } from "./buildComputerMcp.js";
import { fakeBuildComputerRea } from "./fakeBuildComputerRea.js";
import { createTestTempDirectory } from "./temporaryDirectory.js";

/** The task the agent writes for the seed-and-end capture. */
export const BUILD_TASK = {
  name: "add-eggs",
  prompt: "Add eggs to today's list and save it.",
  checks: [
    { kind: "lines_present", file: "Documents/today.txt", lines: ["eggs"] },
  ],
};
/** A request for an app from the Ubuntu archive. */
export const BUILD_REQUEST = {
  kind: "request",
  desktop_entry: "org.example.notes",
  install: { kind: "archive", package: "notes" },
};
const ENDS = ["--seed-checkpoint", "seed", "--end-checkpoint", "end"];

/** What the real CLI writes for a capture made between seed and end: the draft, and the export with BUILD_TASK. */
const realCliOutputs = async () => {
  const capture = await writeCaptureFolder(seedEndCapture(), undefined, [
    EDITED_NOTE,
  ]);
  const work = await createTestTempDirectory("build-cli-");
  const task = join(work, "task.json");
  await writeFile(task, JSON.stringify(BUILD_TASK));
  const bundle = join(work, "bundle");
  const draft = await serveCli([
    "describe-desktop-application-task",
    capture,
    ...ENDS,
    "--json",
  ]);
  const exported = await serveCli([
    "export-desktop-application",
    capture,
    bundle,
    "--task",
    task,
    ...ENDS,
    "--json",
  ]);
  expect(exported.exitCode, exported.stdout).toBe(0);
  await writeFile(join(work, "draft.json"), draft.stdout);
  await writeFile(join(work, "export.json"), exported.stdout);
  return {
    capture,
    draft: join(work, "draft.json"),
    export: join(work, "export.json"),
    bundle,
  };
};

/**
 * A REA server whose build computers run REA's controller on this host
 * against a REA stand-in printing the real CLI's outputs. `dropReplies`
 * names controller commands, in order, whose reply is lost after they run;
 * `env` adds to the stand-in's environment.
 */
export const buildCaptureFakes = async (
  options: {
    readonly dropReplies?: string[];
    readonly env?: Readonly<Record<string, string>>;
  } = {},
) => {
  const outputs = await realCliOutputs();
  const rea = await fakeBuildComputerRea(outputs);
  const { computer, runner } = await buildComputerFakes({
    exec: {
      home: rea.home,
      bin: rea.bin,
      env: { ...rea.env, ...options.env },
      dropReplies: options.dropReplies ?? [],
    },
  });
  const payload = join(runner.state, "rea-prod.tar.xz");
  await writeFile(payload, "a packed REA build");
  const client = await connectBuildServer({
    ...runner.environment,
    REA_BUILD_COMPUTER_REA_ARCHIVE: payload,
  });
  return { rea, outputs, computer, client };
};
