import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { build } from "plist";
import { describe, expect, it } from "vitest";

import {
  NativeDmgArtifactReader,
  type NativeDmgHost,
} from "../../../../src/artifacts/NativeDmgArtifactReader.js";

describe("native DMG artifact reader", () => {
  it("uses plist attachment metadata and detaches returned devices", async () => {
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
    const first = provenance[0];
    if (first === undefined) throw new Error("expected attachment provenance");
    Reflect.set(first, "tool", "forged");
    expect(reader.provenance()[0]?.tool).toBe("/usr/bin/hdiutil");
    await reader.close();
    expect(calls).toContainEqual(["verify", "/tmp/image.dmg"]);
    expect(calls).toContainEqual(["detach", "/dev/disk-fixture"]);
  });

  it("rejects non-zero results and surfaces detach failure during attach cleanup", async () => {
    await expect(
      NativeDmgArtifactReader.create("/tmp/image.dmg", undefined, {
        run: () =>
          Promise.resolve({
            stdout: "verify output",
            stderr: "hdiutil: verification failed",
            exitCode: 1,
          }),
      }),
    ).rejects.toMatchObject({
      reason: "unavailable",
      message: expect.stringMatching(
        /"arguments":\["verify","\/tmp\/image\.dmg"\].*"exitCode":1.*"stderr":"hdiutil: verification failed"/u,
      ),
    });

    const host: NativeDmgHost = {
      run(arguments_) {
        if (arguments_[0] === "detach")
          return Promise.reject(new Error("detach failed"));
        if (arguments_[0] === "info")
          return Promise.resolve({
            stdout: build({
              images: [
                { "system-entities": [{ "dev-entry": "/dev/disk-fixture" }] },
              ],
            }),
            exitCode: 0,
          });
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

it("owns the canonical mount root and detaches each observed whole image once", async () => {
  const calls: string[][] = [];
  const host: NativeDmgHost = {
    async run(arguments_) {
      calls.push([...arguments_]);
      if (arguments_[0] !== "attach") return { stdout: "", exitCode: 0 };
      const mountRoot = arguments_[arguments_.indexOf("-mountroot") + 1];
      if (mountRoot === undefined) throw new Error("missing mount root");
      expect(mountRoot).toBe(await realpath(mountRoot));
      const mountPoint = join(await realpath(mountRoot), "Fixture");
      await mkdir(mountPoint);
      await writeFile(join(mountPoint, "hello.txt"), "hello");
      return {
        stdout: build({
          "system-entities": [
            { "dev-entry": "/dev/disk41" },
            { "dev-entry": "/dev/disk41s1" },
            { "dev-entry": "/dev/disk41s2", "mount-point": mountPoint },
            { "dev-entry": "/dev/disk42" },
            { "dev-entry": "/dev/disk42s1" },
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
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry.path);
    expect(entries).toContain("image.dmg/Fixture/hello.txt");
  } finally {
    await reader.close();
  }
  expect(calls.filter((call) => call[0] === "detach")).toEqual([
    ["detach", "/dev/disk42"],
    ["detach", "/dev/disk41"],
  ]);
});

describe("APFS disk image detach", () => {
  // hdiutil reports the image disk and its synthesized APFS container as two
  // whole disks; detaching the container ejects the image disk as well.
  const apfsHost = (stillListed: readonly string[]) => {
    const calls: string[][] = [];
    const host: NativeDmgHost = {
      async run(arguments_) {
        calls.push([...arguments_]);
        if (arguments_[0] === "detach" && arguments_[1] === "/dev/disk4")
          throw new Error("hdiutil: detach failed - No such file or directory");
        if (arguments_[0] === "info")
          return {
            stdout: build({
              images:
                stillListed.length === 0
                  ? []
                  : [
                      {
                        "system-entities": stillListed.map((device) => ({
                          "dev-entry": device,
                        })),
                      },
                    ],
            }),
            exitCode: 0,
          };
        if (arguments_[0] !== "attach") return { stdout: "", exitCode: 0 };
        const mountRoot = arguments_[arguments_.indexOf("-mountroot") + 1];
        if (mountRoot === undefined) throw new Error("missing mount root");
        const mountPoint = join(mountRoot, "Fixture");
        await mkdir(mountPoint);
        return {
          stdout: build({
            "system-entities": [
              { "dev-entry": "/dev/disk4" },
              { "dev-entry": "/dev/disk4s1" },
              { "dev-entry": "/dev/disk5s1", "mount-point": mountPoint },
              { "dev-entry": "/dev/disk5" },
            ],
          }),
          exitCode: 0,
        };
      },
    };
    return { calls, host };
  };

  it("accepts an image disk that its container detach already ejected", async () => {
    const { calls, host } = apfsHost([]);
    const reader = await NativeDmgArtifactReader.create(
      "/tmp/image.dmg",
      undefined,
      host,
    );
    await reader.close();
    expect(
      calls.filter((call) => call[0] !== "verify" && call[0] !== "attach"),
    ).toEqual([
      ["detach", "/dev/disk5"],
      ["detach", "/dev/disk4"],
      ["info", "-plist"],
    ]);
    expect(reader.provenance().map(({ arguments: args }) => args[0])).toEqual([
      "verify",
      "attach",
      "detach",
    ]);
  });

  it("still fails when the device that rejected detach remains attached", async () => {
    const { host } = apfsHost(["/dev/disk4", "/dev/disk4s1"]);
    const reader = await NativeDmgArtifactReader.create(
      "/tmp/image.dmg",
      undefined,
      host,
    );
    await expect(reader.close()).rejects.toThrow(
      "DMG detach or mount-root cleanup failed",
    );
  });
});
