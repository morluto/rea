import childProcess, { ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";

import { createCliShell } from "../../src/cli/cliShell.js";
import { PRODUCT_IDENTITY } from "../../src/identity.js";
import { HOST_PLATFORM } from "../../src/platform/HostPlatform.js";
import { snapshotEnvironment } from "../../src/process/snapshotEnvironment.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

it.each(["XDG cache", "home fallback"] as const)(
  "schedules a stale notice refresh with the selected environment and %s",
  async (source) => {
    const root = await createTestTempDirectory("rea-notice-selected-env-");
    const selected = {
      ...(source === "XDG cache"
        ? { XDG_CACHE_HOME: join(root, "selected") }
        : {}),
      HOME: join(root, "selected-home"),
      USERPROFILE: join(root, "selected-home"),
      npm_config_registry: "http://127.0.0.1:9/selected/",
      CI: "false",
      NO_UPDATE_NOTIFIER: "",
      SELECTED_SETTING: "original",
    };
    const cli = createCliShell({
      selectedEnvironment: selected,
      registrations: [],
    });
    const expected = snapshotEnvironment(selected, HOST_PLATFORM.platform);
    selected.SELECTED_SETTING = "changed after CLI construction";
    const argv = process.argv;
    const exitCode = process.exitCode;
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const child = new ChildProcess();
    const spawn = vi.spyOn(childProcess, "spawn").mockReturnValue(child);
    syncBuiltinESMExports();
    vi.stubEnv("XDG_CACHE_HOME", join(root, "ambient"));
    vi.stubEnv("HOME", join(root, "ambient-home"));
    vi.stubEnv("USERPROFILE", join(root, "ambient-home"));
    vi.stubEnv("npm_config_registry", "http://127.0.0.1:9/ambient/");
    vi.stubEnv("AMBIENT_ONLY", "must not be inherited");
    try {
      process.argv = [process.execPath, resolve("scripts/rea.mjs")];
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: true,
      });
      await cli.serve(["no-such-command"], {
        stdout: () => {},
        exit: () => {},
      });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0]?.[2]).toMatchObject({
        detached: true,
        stdio: "ignore",
        env: expected,
      });
      expect(spawn.mock.calls[0]?.[2]?.env).toEqual(expected);
      const cache = join(
        source === "XDG cache"
          ? selected.XDG_CACHE_HOME!
          : join(selected.HOME, ".cache"),
        "incur",
        "updates",
        `${encodeURIComponent(PRODUCT_IDENTITY.packageName)}.json`,
      );
      expect(JSON.parse(await readFile(cache, "utf8"))).toEqual({
        checkedAt: expect.any(Number),
      });
      await expect(
        readFile(
          join(
            root,
            "ambient",
            "incur",
            "updates",
            `${encodeURIComponent(PRODUCT_IDENTITY.packageName)}.json`,
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      if (tty === undefined) Reflect.deleteProperty(process.stdout, "isTTY");
      else Object.defineProperty(process.stdout, "isTTY", tty);
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      vi.unstubAllEnvs();
    }
  },
);
