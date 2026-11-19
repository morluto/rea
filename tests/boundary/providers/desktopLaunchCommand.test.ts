import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  capturedHomePlan,
  launchCommand,
} from "../../../src/domain/desktop/appExport.js";
import { planLaunch } from "../../../src/application/desktop/DesktopExportLaunch.js";
import type { DesktopApplicationCapture } from "../../../src/domain/desktop/desktopCapture.js";

it.skipIf(process.platform === "win32").each([
  ["--chdir", false],
  ["-iC", true],
])(
  "replays an empty directory selected by env %s with the expected environment",
  (option, clean) => {
    const home = mkdtempSync(join(tmpdir(), "rea-working-home-"));
    try {
      const selected = "Projects/Empty workspace";
      const capture = {
        host: { home: "/home/ada" },
        application: {
          argv: [
            "/usr/bin/env",
            option,
            `/home/ada/${selected}`,
            process.execPath,
            "-e",
            "console.log(process.cwd()); console.log(process.env.REA_REPLAY_MARKER)",
          ],
          working_directory: "/home/ada/ambient",
          application_working_directory: `/home/ada/${selected}`,
          state_directories: [],
        },
        state: { state_directories: [] },
      } as unknown as DesktopApplicationCapture;
      const {
        command: [program, ...args],
      } = planLaunch(capture, false, new Map(), {
        ...capturedHomePlan(capture),
        files: new Map(),
        restoredFiles: [],
      });
      const result = spawnSync(program!, args, {
        encoding: "utf8",
        env: { ...process.env, HOME: home, REA_REPLAY_MARKER: "inherited" },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trimEnd().split("\n")).toEqual([
        join(realpathSync(home), selected),
        clean ? "undefined" : "inherited",
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "does not import seeded Python modules while encoding a file URL",
  () => {
    const home = mkdtempSync(join(tmpdir(), "rea-url-home-"));
    try {
      writeFileSync(
        join(home, "urllib.py"),
        'open("seed-ran", "w").write("unexpected")\n',
      );
      const command = launchCommand(
        [
          process.execPath,
          "-e",
          "process.stdout.write(process.argv[1])",
          "file:///home/ada/Documents/report.txt",
        ],
        "/home/ada",
        "/home/ada",
      );
      const result = spawnSync(command[0]!, command.slice(1), {
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(
        pathToFileURL(join(home, "Documents/report.txt")).href,
      );
      expect(existsSync(join(home, "seed-ran"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "launches captured file URLs under the runtime home with their encoded suffix, query, and fragment",
  () => {
    for (const prefix of ["file://", "file://localhost"]) {
      const captured = `${prefix}/home/ada/Documents/%41%20budget.svg?mode=edit#page`;
      const command = launchCommand(
        [
          process.execPath,
          "-e",
          "process.stdout.write(process.argv[1])",
          captured,
        ],
        "/home/ada",
        "/home/ada",
      );
      const result = spawnSync(command[0]!, command.slice(1), {
        encoding: "utf8",
        env: { ...process.env, HOME: "/tmp/Run #测" },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(
        `${prefix}/tmp/Run%20%23%E6%B5%8B/Documents/%41%20budget.svg?mode=edit#page`,
      );
    }
  },
);
