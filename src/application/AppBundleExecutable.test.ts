import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveAppBundleExecutable } from "./AppBundleExecutable.js";

describe("app bundle Info.plist magic", () => {
  it("does not decode a high-bit fold of bplist as a binary Info.plist", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-bplist-fold-"));
    try {
      const bundle = join(root, "Fixture.app");
      const plistPath = join(bundle, "Contents", "Info.plist");
      await mkdir(join(bundle, "Contents"), { recursive: true });
      const plist = Buffer.from("bplist00");
      plist[0] = (plist[0] ?? 0) | 0x80;
      await writeFile(plistPath, plist);
      let decoded = false;
      const result = await resolveAppBundleExecutable(bundle, {
        readFile: async () => plist,
        realpath: async (path) => path,
        decodeBinaryPlist: async () => {
          decoded = true;
          return "Fixture";
        },
      });
      expect(decoded).toBe(false);
      expect(result.ok).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
