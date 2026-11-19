import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { dumpDconfDatabase } from "../../desktop/DconfDatabaseReader.js";
import { desktopApplicationStateSchema } from "../../domain/desktop/desktopState.js";
import { inspectDesktopApplicationState } from "./DesktopApplicationState.js";
import {
  HOME,
  capture,
  checkpoint,
  readers,
  retained,
  writeCaptureFolder,
} from "./desktopCapture.fixture.js";

it.skipIf(process.platform === "win32")(
  "retains a dconf command failure in state Evidence",
  async () => {
    const tools = await createTestTempDirectory("dconf-state-diagnostics-");
    const command = join(tools, "dconf");
    await writeFile(command, "#!/bin/sh\nexit 17\n", { mode: 0o600 });
    const base = capture();
    const path = `${HOME}/.config/dconf/user`;
    const bytes = Buffer.from("GVariant\0\0\0\0");
    const folder = await writeCaptureFolder(
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
    const evidence = await inspectDesktopApplicationState(folder, {
      ...readers,
      dconf: (database, signal) =>
        dumpDconfDatabase(database, { REA_DCONF_COMMAND: command }, signal),
    });
    if (!("normalized_result" in evidence)) throw evidence;
    const state = desktopApplicationStateSchema.parse(
      evidence.normalized_result,
    );
    expect(state.paths).toEqual([
      expect.objectContaining({
        home_path: ".config/dconf/user",
        versions: [
          expect.objectContaining({
            format: "dconf",
            view: null,
            view_error: expect.stringContaining("EACCES"),
          }),
        ],
      }),
    ]);
    expect(state.paths[0]?.versions[0]?.view_error).toContain(command);
  },
);
