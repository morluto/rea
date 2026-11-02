import { constants as fsConstants, type Stats } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
  readlink: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readlink: filesystem.readlink,
    stat: filesystem.stat,
  };
});

import { verifyInferiorInputSink } from "./inferiorInputSink.js";

const characterDevice = (rdev: number): Stats =>
  ({
    mode: fsConstants.S_IFCHR,
    dev: 1,
    ino: 1,
    rdev,
  }) as Stats;

const linuxIt = it.skipIf(process.platform !== "linux");

afterEach(() => {
  filesystem.readlink.mockReset();
  filesystem.stat.mockReset();
});

linuxIt(
  "does not combine a stale /dev/null link with another character device",
  async () => {
    filesystem.readlink.mockResolvedValue("/dev/null");
    filesystem.stat.mockImplementation(async (path: string) =>
      path === "/dev/null" ? characterDevice(3) : characterDevice(9),
    );

    await expect(
      verifyInferiorInputSink("123", {
        path: "/dev/pts/none",
        dev: 0,
        ino: 0,
      }),
    ).rejects.toThrow(/unverified/u);
  },
);

linuxIt(
  "accepts fd 0 only when its character device matches /dev/null",
  async () => {
    filesystem.readlink.mockResolvedValue("/dev/null");
    filesystem.stat.mockResolvedValue(characterDevice(3));

    await expect(
      verifyInferiorInputSink("123", {
        path: "/dev/pts/none",
        dev: 0,
        ino: 0,
      }),
    ).resolves.toBe("not-inherited");
  },
);
