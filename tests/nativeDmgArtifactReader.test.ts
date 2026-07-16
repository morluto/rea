import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { build } from "plist";
import { describe, expect, it } from "vitest";

import {
  NativeDmgArtifactReader,
  type NativeDmgHost,
} from "../src/artifacts/NativeDmgArtifactReader.js";

describe("native DMG artifact reader", () => {
  it("uses plist attachment metadata and detaches returned devices", async () => {
    if (process.platform !== "darwin") return;
    const calls: string[][] = [];
    const host: NativeDmgHost = {
      async run(arguments_) {
        const args = [...arguments_];
        calls.push(args);
        if (args[0] !== "attach") return { stdout: "", exitCode: 0 };
        const mountRoot = args[args.indexOf("-mountroot") + 1];
        if (mountRoot === undefined) throw new Error("missing mount root");
        const mountPoint = join(mountRoot, "Fixture");
        await mkdir(mountPoint);
        await writeFile(join(mountPoint, "hello.txt"), "hello");
        return {
          stdout: build({
            "system-entities": [
              { "dev-entry": "/dev/disk-fixture", "mount-point": mountPoint },
            ],
          }),
          exitCode: 0,
        };
      },
    };
    const reader = await NativeDmgArtifactReader.create(
      "/tmp/image.dmg",
      undefined,
      host,
    );
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry.path);
    expect(entries).toContain("image.dmg/Fixture/hello.txt");
    const provenance = reader.provenance();
    if (provenance[0] !== undefined)
      Reflect.set(provenance[0], "tool", "forged");
    expect(reader.provenance()[0]?.tool).toBe("/usr/bin/hdiutil");
    await reader.close();
    expect(calls).toContainEqual(["verify", "/tmp/image.dmg"]);
    expect(calls).toContainEqual(["detach", "/dev/disk-fixture"]);
  });

  it("rejects non-zero results and surfaces detach failure during attach cleanup", async () => {
    if (process.platform !== "darwin") return;
    await expect(
      NativeDmgArtifactReader.create("/tmp/image.dmg", undefined, {
        run: () => Promise.resolve({ stdout: "", exitCode: 1 }),
      }),
    ).rejects.toThrow("non-zero exit code");

    const host: NativeDmgHost = {
      run(arguments_) {
        if (arguments_[0] === "detach")
          return Promise.reject(new Error("detach failed"));
        if (arguments_[0] !== "attach")
          return Promise.resolve({ stdout: "", exitCode: 0 });
        return Promise.resolve({
          stdout: build({
            "system-entities": [
              {
                "dev-entry": "/dev/disk-fixture",
                "mount-point": "/tmp/not-owned",
              },
            ],
          }),
          exitCode: 0,
        });
      },
    };
    await expect(
      NativeDmgArtifactReader.create("/tmp/image.dmg", undefined, host),
    ).rejects.toThrow("cleanup could not detach every device");
  });
});
