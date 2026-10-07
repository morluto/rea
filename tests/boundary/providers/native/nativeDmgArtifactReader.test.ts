import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { build } from "plist";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { ArtifactReaderFailure } from "../../../../src/artifacts/ArtifactReader.js";
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
      reason: "format",
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

describe("native DMG command failure diagnostics", () => {
  it("keeps unknown attach failures unavailable with command evidence", async () => {
    await expect(
      NativeDmgArtifactReader.create("/tmp/image.dmg", undefined, {
        run(arguments_) {
          if (arguments_[0] === "verify")
            return Promise.resolve({ stdout: "", exitCode: 0 });
          return Promise.resolve({
            stdout: "attach output",
            stderr: "attach failed for an unknown reason",
            exitCode: 2,
          });
        },
      }),
    ).rejects.toMatchObject({
      reason: "unavailable",
      message: expect.stringMatching(
        /"arguments":\["attach".*"exitCode":2.*"stderr":"attach failed for an unknown reason"/u,
      ),
    });
  });

  it("distinguishes child launch and host permission failures", async () => {
    await expect(
      NativeDmgArtifactReader.create("/tmp/image.dmg", undefined, {
        run: () =>
          Promise.reject(
            Object.assign(new Error("could not launch hdiutil"), {
              code: "ENOENT",
              syscall: "spawn /usr/bin/hdiutil",
            }),
          ),
      }),
    ).rejects.toMatchObject({
      reason: "unavailable",
      message: expect.stringContaining('"code":"ENOENT"'),
    });

    await expect(
      NativeDmgArtifactReader.create("/tmp/image.dmg", undefined, {
        run: () =>
          Promise.reject(
            Object.assign(new Error("permission denied"), {
              code: "EACCES",
              syscall: "spawn /usr/bin/hdiutil",
            }),
          ),
      }),
    ).rejects.toMatchObject({
      reason: "io",
      message: expect.stringContaining('"code":"EACCES"'),
    });
  });

  it.skipIf(process.platform !== "darwin")(
    "classifies a real hdiutil verify refusal as a format failure with captured output",
    async () => {
      const root = await createTestTempDirectory("rea-invalid-dmg-");
      const path = join(root, "invalid.dmg");
      await writeFile(path, "This is not a disk image.\n");
      const failure = await NativeDmgArtifactReader.create(path).catch(
        (cause: unknown) => cause,
      );
      expect(failure).toBeInstanceOf(ArtifactReaderFailure);
      if (!(failure instanceof ArtifactReaderFailure)) return;
      expect(failure.reason).toBe("format");
      expect(failure.message).toContain('"command":"/usr/bin/hdiutil"');
      expect(failure.message).toContain('"arguments":["verify"');
      expect(failure.message).toContain('"exitCode":1');
      expect(failure.message).toContain('"stdout":""');
      expect(failure.message).toContain('"stderr":"');
    },
  );
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
