import { lstat, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { walkHomeState } from "./HomeStateWalker.js";

describe("walkHomeState", () => {
  it("records files, directories and links without following links or entering exclusions", async () => {
    const home = await createTestTempDirectory("desktop-walk-");
    await mkdir(join(home, ".config/app"), { recursive: true });
    await writeFile(join(home, ".config/app/settings.ini"), "a=1\n");
    await mkdir(join(home, "capture/content"), { recursive: true });
    await writeFile(join(home, "capture/content/x"), "x");
    await symlink(join(home, ".config"), join(home, "config-link"));

    const walk = await walkHomeState([home], [join(home, "capture")], 100);

    expect([...walk.entries.keys()].sort()).toEqual(
      [
        home,
        join(home, ".config"),
        join(home, ".config/app"),
        join(home, ".config/app/settings.ini"),
        join(home, "config-link"),
      ].sort(),
    );
    expect(walk.entries.get(join(home, "config-link"))?.type).toBe("symlink");
    expect(
      walk.entries.get(join(home, ".config/app/settings.ini")),
    ).toMatchObject({ type: "file", size: 4 });
    expect(walk.truncated).toBe(false);
  });

  it("stops at the entry limit and reports truncation", async () => {
    const home = await createTestTempDirectory("desktop-walk-limit-");
    for (const name of ["a", "b", "c", "d"])
      await writeFile(join(home, name), name);

    const walk = await walkHomeState([home], [], 3);

    expect(walk.entries.size).toBe(3);
    expect(walk.truncated).toBe(true);
  });

  it("skips roots that do not exist", async () => {
    const home = await createTestTempDirectory("desktop-walk-missing-");
    const walk = await walkHomeState([join(home, "missing")], [], 10);
    expect(walk.entries.size).toBe(0);
  });

  // Linux mounts devpts, shm and mqueue under /dev, a root on its own device.
  it.skipIf(process.platform !== "linux")(
    "records a directory on another device without entering it",
    async () => {
      const root = "/dev";
      const rootDevice = (await lstat(root)).dev;
      const mounted: string[] = [];
      for (const name of await readdir(root)) {
        const stats = await lstat(join(root, name)).catch(() => undefined);
        if (stats?.isDirectory() === true && stats.dev !== rootDevice)
          mounted.push(join(root, name));
      }

      const walk = await walkHomeState([root], [], 100_000);

      expect(
        walk.mountPoints.filter((path) => dirname(path) === root).sort(),
      ).toEqual(mounted.sort());
      for (const mountPoint of mounted) {
        expect(walk.entries.get(mountPoint)?.type).toBe("directory");
        expect(
          [...walk.entries.keys()].some((path) =>
            path.startsWith(`${mountPoint}/`),
          ),
        ).toBe(false);
      }
    },
  );
});
