import { access, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { describe, expect, it } from "vitest";

import { buildLinuxX64ReplaySeccomp } from "../../../src/replay/LinuxSeccompPolicy.js";
import { temporaryFilterHandle } from "../../../src/replay/ReplaySeccompFile.js";

describe("replay seccomp file ownership", () => {
  it("writes the policy bytes and removes its private directory on close", async () => {
    const filter = await temporaryFilterHandle();
    try {
      expect(await readFile(filter.path)).toEqual(
        Buffer.from(buildLinuxX64ReplaySeccomp()),
      );
      expect(await filter.handle.readFile()).toEqual(
        Buffer.from(buildLinuxX64ReplaySeccomp()),
      );
    } finally {
      await filter.close();
    }
    await expect(access(dirname(filter.path))).rejects.toThrow();
    await filter.close();
  });

  it.skipIf(process.platform !== "linux")(
    "removes the directory even when descriptor cleanup rejects",
    async () => {
      const filter = await temporaryFilterHandle();
      const close = filter.handle.close.bind(filter.handle);
      const failure = new Error("injected descriptor cleanup failure");
      filter.handle.close = async () => {
        throw failure;
      };
      try {
        await expect(filter.close()).rejects.toBe(failure);
        await expect(access(dirname(filter.path))).rejects.toThrow();
      } finally {
        filter.handle.close = close;
        await filter.close();
      }
    },
  );
});
