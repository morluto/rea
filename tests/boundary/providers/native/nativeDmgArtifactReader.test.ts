import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { build } from "plist";
import { describe, expect, it, onTestFinished } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { execFileOutput } from "../../../../src/process/ExecFileOutput.js";
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
      process.env,
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
      NativeDmgArtifactReader.create("/tmp/image.dmg", process.env, undefined, {
        run: () =>
          Promise.resolve({
            stdout: "verify output",
            stderr: "hdiutil: verify failed - image not recognized",
            exitCode: 1,
          }),
      }),
    ).rejects.toMatchObject({
      reason: "format",
      message: expect.stringMatching(
        /"arguments":\["verify","\/tmp\/image\.dmg"\].*"exitCode":1.*"stderr":"hdiutil: verify failed - image not recognized"/u,
      ),
    });

    let mountRoot: string | undefined;
    onTestFinished(async () => {
      if (mountRoot !== undefined)
        await rm(mountRoot, { recursive: true, force: true });
    });
    const host: NativeDmgHost = {
      delay: () => Promise.resolve(),
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
        mountRoot = arguments_[arguments_.indexOf("-mountroot") + 1];
        if (mountRoot === undefined) throw new Error("missing mount root");
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
      NativeDmgArtifactReader.create(
        "/tmp/image.dmg",
        process.env,
        undefined,
        host,
      ),
    ).rejects.toThrow("cleanup could not detach every device");
  });
});

describe("native DMG command failure diagnostics", () => {
  it("keeps unknown attach failures unavailable with command evidence", async () => {
    await expect(
      NativeDmgArtifactReader.create("/tmp/image.dmg", process.env, undefined, {
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

  it("keeps unrecognized numeric verify failures unknown and maps the observed I/O diagnostic", async () => {
    const unknown = await NativeDmgArtifactReader.create(
      "/tmp/image.dmg",
      process.env,
      undefined,
      {
        run: () =>
          Promise.resolve({
            stdout: "verify stdout",
            stderr: "hdiutil: verify failed - an unrecognized system failure",
            exitCode: 1,
          }),
      },
    ).catch((cause: unknown) => cause);
    expect(unknown).toBeInstanceOf(ArtifactReaderFailure);
    if (!(unknown instanceof ArtifactReaderFailure)) return;
    expect(unknown.reason).toBe("unavailable");
    expect(unknown.message).toContain("do not establish the failure cause");
    expect(unknown.message).toContain('"exitCode":1');
    expect(unknown.message).toContain('"stdout":"verify stdout"');
    expect(unknown.message).toContain("an unrecognized system failure");

    await expect(
      NativeDmgArtifactReader.create("/tmp/image.dmg", process.env, undefined, {
        run: () =>
          Promise.resolve({
            stdout: "",
            stderr: "hdiutil: verify failed - Input/output error\n",
            exitCode: 1,
          }),
      }),
    ).rejects.toMatchObject({
      reason: "io",
      message: expect.stringContaining("Input/output error"),
    });

    await expect(
      NativeDmgArtifactReader.create("/tmp/image.dmg", process.env, undefined, {
        run: () =>
          Promise.resolve({
            stdout: "checksum output",
            stderr: "hdiutil: verify failed - image data corrupted\n",
            exitCode: 1,
          }),
      }),
    ).rejects.toMatchObject({
      reason: "integrity",
      message: expect.stringContaining("image data corrupted"),
    });
  });

  it("distinguishes child launch and host permission failures", async () => {
    await expect(
      NativeDmgArtifactReader.create("/tmp/image.dmg", process.env, undefined, {
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
      NativeDmgArtifactReader.create("/tmp/image.dmg", process.env, undefined, {
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
});

describe("native DMG real verification diagnostics", () => {
  it.skipIf(process.platform !== "darwin")(
    "classifies a real hdiutil verify refusal as a format failure with captured output",
    async () => {
      const root = await createTestTempDirectory("rea-invalid-dmg-");
      const path = join(root, "invalid.dmg");
      await writeFile(path, "This is not a disk image.\n");
      const failure = await NativeDmgArtifactReader.create(
        path,
        process.env,
      ).catch((cause: unknown) => cause);
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

  it.skipIf(process.platform !== "darwin")(
    "classifies real hdiutil target access failures as I/O, separately from malformed images",
    async () => {
      const root = await createTestTempDirectory("rea-dmg-target-errors-");
      const missingPath = join(root, "missing.dmg");
      const unreadablePath = join(root, "unreadable.dmg");
      await writeFile(unreadablePath, "not a disk image\n");
      await chmod(unreadablePath, 0);
      try {
        for (const [path, expectedDiagnostic] of [
          [missingPath, "No such file or directory"],
          [unreadablePath, "Permission denied"],
        ] as const) {
          const failure = await NativeDmgArtifactReader.create(
            path,
            process.env,
          ).catch((cause: unknown) => cause);
          expect(failure).toBeInstanceOf(ArtifactReaderFailure);
          if (!(failure instanceof ArtifactReaderFailure)) continue;
          expect(failure.reason).toBe("io");
          expect(failure.message).toContain('"command":"/usr/bin/hdiutil"');
          expect(failure.message).toContain('"arguments":["verify"');
          expect(failure.message).toContain('"exitCode":1');
          expect(failure.message).toContain('"stdout":""');
          expect(failure.message).toContain(expectedDiagnostic);
          expect(failure.cause).toBeInstanceOf(Error);
          if (!(failure.cause instanceof Error)) continue;
          expect(Reflect.get(failure.cause, "code")).toBe(1);
          expect(Reflect.get(failure.cause, "stderr")).toContain(
            expectedDiagnostic,
          );
        }
      } finally {
        await chmod(unreadablePath, 0o600);
      }
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "classifies a checksum mismatch in an hdiutil-created DMG as an integrity failure",
    async () => {
      const root = await createTestTempDirectory(
        "rea-dmg-checksum-corruption-",
      );
      const writableImagePath = join(root, "writable.dmg");
      const imagePath = join(root, "fixture.dmg");
      await execFileOutput("/usr/bin/hdiutil", [
        "create",
        "-quiet",
        "-size",
        "1m",
        "-layout",
        "NONE",
        "-type",
        "UDIF",
        writableImagePath,
      ]);
      await execFileOutput("/usr/bin/hdiutil", [
        "convert",
        "-quiet",
        writableImagePath,
        "-format",
        "UDRO",
        "-o",
        imagePath,
      ]);
      const valid = await execFileOutput("/usr/bin/hdiutil", [
        "verify",
        imagePath,
      ]);
      expect(valid.stderr).toContain("is VALID");

      const image = await readFile(imagePath);
      const footer = image.subarray(-512);
      expect(footer.subarray(0, 4).toString("ascii")).toBe("koly");
      const dataForkOffset = Number(footer.readBigUInt64BE(24));
      const dataForkLength = Number(footer.readBigUInt64BE(32));
      expect(dataForkLength).toBeGreaterThan(4096);
      const corruptionOffset = dataForkOffset + 4096;
      expect(corruptionOffset).toBeLessThan(dataForkOffset + dataForkLength);
      const originalByte = image[corruptionOffset];
      if (originalByte === undefined)
        throw new Error("expected a byte in the generated image data fork");
      image[corruptionOffset] = originalByte ^ 0x01;
      await writeFile(imagePath, image);

      const failure = await NativeDmgArtifactReader.create(
        imagePath,
        process.env,
      ).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ArtifactReaderFailure);
      if (!(failure instanceof ArtifactReaderFailure)) return;
      expect(failure.reason).toBe("integrity");
      expect(failure.message).toContain('"command":"/usr/bin/hdiutil"');
      expect(failure.message).toContain('"arguments":["verify"');
      expect(failure.message).toContain('"exitCode":1');
      expect(failure.message).toContain("calculated CRC32");
      expect(failure.message).toContain("expected   CRC32");
      expect(failure.message).toContain("verify failed - invalid checksum");
      expect(failure.cause).toBeInstanceOf(Error);
      if (!(failure.cause instanceof Error)) return;
      expect(Reflect.get(failure.cause, "code")).toBe(1);
      expect(Reflect.get(failure.cause, "stderr")).toContain("is INVALID");
    },
    60_000,
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
    process.env,
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

// hdiutil reports the image disk and synthesized APFS container separately;
// detaching the container can already eject the image disk.
const apfsHost = (
  stillListed: readonly string[],
  listedInfoReads = Infinity,
) => {
  const calls: string[][] = [];
  let infoReads = 0;
  let mountRoot: string | undefined;
  onTestFinished(async () => {
    if (mountRoot !== undefined)
      await rm(mountRoot, { recursive: true, force: true });
  });
  const host: NativeDmgHost = {
    delay: () => Promise.resolve(),
    async run(arguments_) {
      calls.push([...arguments_]);
      if (arguments_[0] === "detach" && arguments_[1] === "/dev/disk4")
        throw new Error("hdiutil: detach failed - No such file or directory");
      if (arguments_[0] === "info")
        return {
          stdout: build({
            images:
              stillListed.length === 0 || (infoReads += 1) > listedInfoReads
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
      mountRoot = arguments_[arguments_.indexOf("-mountroot") + 1];
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

// One mounted device whose detach reports busy while `busy(attempt)` holds.
const singleDeviceHost = (busy: (attempt: number) => boolean) => {
  const state = {
    attached: true,
    attempts: 0,
    mountRoot: undefined as string | undefined,
    waits: [] as number[],
  };
  onTestFinished(async () => {
    if (state.mountRoot !== undefined)
      await rm(state.mountRoot, { recursive: true, force: true });
  });
  const host: NativeDmgHost = {
    delay: (milliseconds) => {
      state.waits.push(milliseconds);
      return Promise.resolve();
    },
    async run(args) {
      if (args[0] === "attach") {
        state.mountRoot = args[args.indexOf("-mountroot") + 1];
        if (state.mountRoot === undefined)
          throw new Error("missing mount root");
        const mountPoint = join(state.mountRoot, "Fixture");
        await mkdir(mountPoint);
        await writeFile(join(mountPoint, "hello.txt"), "owned observation");
        return {
          stdout: build({
            "system-entities": [
              { "dev-entry": "/dev/disk7", "mount-point": mountPoint },
            ],
          }),
          exitCode: 0,
        };
      }
      if (args[0] === "info")
        return {
          stdout: build({
            images: state.attached
              ? [{ "system-entities": [{ "dev-entry": "/dev/disk7" }] }]
              : [],
          }),
          exitCode: 0,
        };
      if (args[0] === "detach") {
        state.attempts += 1;
        if (busy(state.attempts))
          return {
            stdout: "",
            stderr: "hdiutil: detach failed - Resource busy",
            exitCode: 16,
          };
        state.attached = false;
      }
      return { stdout: "", exitCode: 0 };
    },
  };
  return { host, state };
};

/** Close an APFS fixture and return the cleanup-phase hdiutil calls. */
const closeApfsFixture = async (
  ...listing: Parameters<typeof apfsHost>
): Promise<{
  readonly reader: NativeDmgArtifactReader;
  readonly cleanup: readonly string[][];
}> => {
  const { calls, host } = apfsHost(...listing);
  const reader = await NativeDmgArtifactReader.create(
    "/tmp/image.dmg",
    process.env,
    undefined,
    host,
  );
  await reader.close();
  return {
    reader,
    cleanup: calls.filter(
      (call) => call[0] !== "verify" && call[0] !== "attach",
    ),
  };
};

describe("APFS disk image detach", () => {
  it("accepts an image disk that its container detach already ejected", async () => {
    const { reader, cleanup } = await closeApfsFixture([]);
    expect(cleanup).toEqual([
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
      process.env,
      undefined,
      host,
    );
    await expect(reader.close()).rejects.toMatchObject({
      reason: "unavailable",
      message: expect.stringContaining("No such file or directory"),
    });
  });

  it("retains a failed attachment and its mount root until a later close detaches it", async () => {
    let busy = true;
    const { host, state } = singleDeviceHost(() => busy);
    const reader = await NativeDmgArtifactReader.create(
      "/tmp/image.dmg",
      process.env,
      undefined,
      host,
    );
    await expect(reader.close()).rejects.toMatchObject({
      reason: "unavailable",
    });
    const { mountRoot } = state;
    if (mountRoot === undefined) throw new Error("missing owned mount root");
    expect
      .soft(
        await readFile(join(mountRoot, "Fixture", "hello.txt"), "utf8").catch(
          () => undefined,
        ),
      )
      .toBe("owned observation");
    busy = false;
    await reader.close();
    expect.soft(state.attached).toBe(false);
    await expect(
      readFile(join(mountRoot, "Fixture", "hello.txt")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("DMG detach recheck", () => {
  it("accepts an ejected device that hdiutil listed once more after its failed detach", async () => {
    const { cleanup } = await closeApfsFixture(
      ["/dev/disk4", "/dev/disk4s1"],
      1,
    );
    expect(cleanup).toEqual([
      ["detach", "/dev/disk5"],
      ["detach", "/dev/disk4"],
      ["info", "-plist"],
      ["info", "-plist"],
    ]);
  });

  it("detaches a device that was busy on its first attempt within one close", async () => {
    const { host, state } = singleDeviceHost((attempt) => attempt === 1);
    const reader = await NativeDmgArtifactReader.create(
      "/tmp/image.dmg",
      process.env,
      undefined,
      host,
    );
    await reader.close();
    expect(state).toMatchObject({
      attempts: 2,
      attached: false,
      waits: [250],
    });
    if (state.mountRoot === undefined)
      throw new Error("missing owned mount root");
    await expect(
      readFile(join(state.mountRoot, "Fixture", "hello.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
