import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { dumpDconfDatabase } from "../../desktop/DconfDatabaseReader.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  desktopApplicationStateSchema,
  type DconfViewFailure,
} from "../../domain/desktop/desktopState.js";
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

const expectReadRefusal = (
  evidence: Evidence | AnalysisError,
  failure: DconfViewFailure,
  error: string | ReturnType<typeof expect.stringMatching>,
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
          view_error: error,
          view_failure: failure,
        }),
      ],
    }),
  ]);
};

it("carries an unavailable descriptor into state Evidence with no empty view", async () => {
  const folder = await dconfCapture();
  const evidence = await inspectDesktopApplicationState(folder, {
    ...readers,
    dconf: async () => ({
      ok: false,
      error: "descriptor path unavailable",
      kind: "descriptor-unavailable",
      code: "ENOENT",
      exitCode: null,
      command: null,
      stderr: null,
    }),
  });
  expectReadRefusal(
    evidence,
    {
      kind: "descriptor-unavailable",
      code: "ENOENT",
      exit_code: null,
      command: null,
      stderr: null,
    },
    "descriptor path unavailable",
  );
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
    expectReadRefusal(
      evidence,
      {
        kind: "launch-failed",
        code: "EACCES",
        exit_code: null,
        command,
        stderr: null,
      },
      expect.stringMatching(/\S/u),
    );
  },
);
