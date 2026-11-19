import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { dumpDconfDatabase } from "../../desktop/DconfDatabaseReader.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { desktopApplicationStateSchema } from "../../domain/desktop/desktopState.js";
import type { Evidence } from "../../domain/evidence.js";
import { inspectDesktopApplicationState } from "./DesktopApplicationState.js";
import {
  HOME,
  capture,
  checkpoint,
  readers,
  retained,
  writeCaptureFolder,
} from "./desktopCapture.fixture.js";

const dconfCapture = async () => {
  const base = capture();
  const path = `${HOME}/.config/dconf/user`;
  const bytes = Buffer.from("GVariant\0\0\0\0");
  return writeCaptureFolder(
    {
      ...base,
      state: {
        ...base.state,
        content_roots: [path],
        checkpoints: [
          checkpoint("baseline", "baseline", [], [retained(path, bytes)]),
        ],
      },
    },
    undefined,
    [bytes],
  );
};

const expectLaunchRefusal = (
  evidence: Evidence | AnalysisError,
  command: string,
) => {
  if (!("normalized_result" in evidence)) throw evidence;
  const state = desktopApplicationStateSchema.parse(evidence.normalized_result);
  expect(state.paths).toEqual([
    expect.objectContaining({
      home_path: ".config/dconf/user",
      versions: [
        expect.objectContaining({
          format: "dconf",
          view: null,
          view_failure: {
            kind: "launch-failed",
            code: "EACCES",
            exit_code: null,
            command,
            stderr: null,
          },
        }),
      ],
    }),
  ]);
};

it("carries a classified dconf failure into state Evidence", async () => {
  const command = "/selected/dconf";
  const folder = await dconfCapture();
  const evidence = await inspectDesktopApplicationState(folder, {
    ...readers,
    dconf: async () => ({
      ok: false,
      error: "execution denied",
      kind: "launch-failed",
      code: "EACCES",
      exitCode: null,
      command,
      stderr: null,
    }),
  });
  expectLaunchRefusal(evidence, command);
});

it.skipIf(process.platform !== "linux")(
  "retains a real dconf command failure in state Evidence",
  async () => {
    const tools = await createTestTempDirectory("dconf-state-diagnostics-");
    const command = join(tools, "dconf");
    await writeFile(command, "#!/bin/sh\nexit 17\n", { mode: 0o600 });
    const folder = await dconfCapture();
    const evidence = await inspectDesktopApplicationState(folder, {
      ...readers,
      dconf: (database, signal) =>
        dumpDconfDatabase(database, { REA_DCONF_COMMAND: command }, signal),
    });
    expectLaunchRefusal(evidence, command);
  },
);
