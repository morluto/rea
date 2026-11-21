import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ELECTRON_FUSE_STATE_BYTES } from "../domain/electron/electronFuses.js";
import {
  elfFuseImage,
  OBSIDIAN_FUSE_BYTES,
  peFuseImage,
  thinFuseImage,
  thinMacho,
  universalFuseImage,
} from "../../tests/fixtures/electron/fuseImage.js";
import { ArtifactReaderFailure } from "../resources/ArtifactReader.js";
import { AnalysisUnsupportedTargetError } from "../domain/analysisErrorCore.js";
import { assertNodeCliInspectArgumentsSupported } from "./PlaywrightElectronActiveFuses.js";

const thinWithInspectState = (state: "enabled" | "removed") => {
  const fuses: number[] = [...OBSIDIAN_FUSE_BYTES];
  fuses[3] = ELECTRON_FUSE_STATE_BYTES[state];
  return thinFuseImage(fuses).bytes;
};

describe("Electron inspect argument preflight", () => {
  it.each([
    ["disabled.exe", peFuseImage(OBSIDIAN_FUSE_BYTES).bytes],
    ["disabled-elf", elfFuseImage(OBSIDIAN_FUSE_BYTES).bytes],
    ["removed-macho", thinWithInspectState("removed")],
  ] as const)(
    "refuses %s with its caller path and passive recovery",
    async (name, bytes) => {
      const root = await createTestTempDirectory("rea-fuse-preflight-");
      const path = join(root, name);
      await writeFile(path, bytes);
      await expect(
        assertNodeCliInspectArgumentsSupported(path),
      ).rejects.toMatchObject({
        _tag: "AnalysisUnsupportedTargetError",
        operation: "capture_electron_scenario",
        path,
        remediationAction: expect.stringContaining("inspect_electron_page"),
      });
    },
  );

  it("admits enabled fuses and leaves unavailable fuse facts undecided", async () => {
    const root = await createTestTempDirectory("rea-fuse-preflight-");
    for (const [name, bytes] of [
      ["enabled-macho", thinWithInspectState("enabled")],
      [
        "without-sentinel",
        thinMacho(0x0100000c, Buffer.from("no-sentinel-bytes-here")),
      ],
      ["unsupported.sh", "#!/bin/sh\necho hello"],
    ] as const) {
      const path = join(root, name);
      await writeFile(path, bytes);
      await expect(
        assertNodeCliInspectArgumentsSupported(path),
        name,
      ).resolves.toBeUndefined();
    }
  });

  it("preserves caller cancellation during the fuse read", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel during fuse read");
    const failure: unknown = await assertNodeCliInspectArgumentsSupported(
      "/nonexistent/binary",
      {
        signal: controller.signal,
        readFuseImage: async () => {
          controller.abort(reason);
          throw new Error("read interrupted");
        },
      },
    ).catch((cause: unknown) => cause);
    if (!(failure instanceof ArtifactReaderFailure))
      throw new Error("Expected a fuse read cancellation", { cause: failure });
    expect(failure.reason).toBe("cancelled");
    expect(failure.cause).toBe(reason);
  });

  it("rejects macOS app bundle when framework binary has disabled inspect fuse", async () => {
    const root = await createTestTempDirectory("rea-fuse-mac-bundle-");
    const appBundle = join(root, "Obsidian.app");
    const launcherBinary = join(appBundle, "Contents", "MacOS", "Obsidian");
    const frameworkDir = join(
      appBundle,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "A",
    );
    await mkdir(join(appBundle, "Contents", "MacOS"), { recursive: true });
    await mkdir(frameworkDir, { recursive: true });

    // Launcher binary has no sentinel:
    await writeFile(launcherBinary, Buffer.from("dummy launcher binary"));

    // Framework binary has the disabled fuse wire:
    const frameworkBinary = join(frameworkDir, "Electron Framework");
    await writeFile(frameworkBinary, thinFuseImage(OBSIDIAN_FUSE_BYTES).bytes);

    await expect(
      assertNodeCliInspectArgumentsSupported(launcherBinary),
    ).rejects.toMatchObject({
      _tag: "AnalysisUnsupportedTargetError",
      operation: "capture_electron_scenario",
      path: launcherBinary,
    });
  });

  it("evaluates matching architecture slice in universal Mach-O binary", async () => {
    const root = await createTestTempDirectory("rea-fuse-preflight-");
    const binaryPath = join(root, "universal-app");
    // universalFuseImage has left (x86_64) disabled, right (arm64) enabled
    const image = universalFuseImage();
    await writeFile(binaryPath, image.bytes);

    if (process.arch === "arm64") {
      await expect(
        assertNodeCliInspectArgumentsSupported(binaryPath),
      ).resolves.toBeUndefined();
    } else {
      await expect(
        assertNodeCliInspectArgumentsSupported(binaryPath),
      ).rejects.toThrow(AnalysisUnsupportedTargetError);
    }
  });
});
