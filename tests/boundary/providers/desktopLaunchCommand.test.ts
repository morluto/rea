import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { launchCommand } from "../../../src/domain/desktop/appExport.js";

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
