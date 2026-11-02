import { createHash } from "node:crypto";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseBinaryTarget } from "../application/BinaryTargetResolver.js";
import { parseConfig } from "../config/parseConfig.js";
import { parseExecutableHeader } from "../domain/binaryTarget.js";
import { fat, thinMach } from "../domain/binaryTarget.fixture.js";
import { silentLogger } from "../logger.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { GhidraClient } from "./GhidraClient.js";
import { ghidraProfileInstallationHost } from "./GhidraInstallation.fixture.js";
import type { GhidraLaunchSession } from "./GhidraLauncher.js";
import { GhidraProvider } from "./GhidraProvider.js";
import { createGhidraTargetSnapshot } from "./GhidraTargetSnapshot.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

const universalTarget = async (
  bytes: Buffer,
  hostArchitecture: "arm64" | "x64",
) => {
  const directory = await createTestTempDirectory("rea-ghidra-thin-");
  roots.push(directory);
  const path = join(directory, "universal");
  await writeFile(path, bytes);
  const resolved = await parseBinaryTarget(path, { hostArchitecture });
  if (!resolved.ok) throw resolved.error;
  if (resolved.value.format !== "mach-o-universal")
    throw new Error("the universal fixture did not resolve as a FAT container");
  const { offset, size } = resolved.value.universalSlice;
  return {
    directory,
    target: resolved.value,
    slice: bytes.subarray(offset, offset + size),
  };
};

/** Slices spanning several 64 KiB reads, each filled with its own byte. */
const largeUniversal = (
  layout: readonly { cpu: number; offset: number; size: number }[],
) => {
  const bytes = Buffer.alloc(
    Math.max(...layout.map(({ offset, size }) => offset + size)),
  );
  bytes.writeUInt32BE(0xcafebabe, 0);
  bytes.writeUInt32BE(layout.length, 4);
  layout.forEach(({ cpu, offset, size }, index) => {
    const entry = 8 + index * 20;
    bytes.writeUInt32BE(cpu, entry);
    bytes.writeUInt32BE(offset, entry + 8);
    bytes.writeUInt32BE(size, entry + 12);
    bytes.writeUInt32BE(12, entry + 16);
    bytes.fill(0x11 * (index + 1), offset, offset + size);
    thinMach(0xfeedfacf, cpu).copy(bytes, offset);
  });
  return bytes;
};

describe("Ghidra universal Mach-O import thinning", () => {
  it.each([
    { host: "arm64", cpu: 0x0100000c },
    { host: "x64", cpu: 0x01000007 },
  ] as const)(
    "imports only the $host host slice and binds Ghidra to its digest",
    async ({ host, cpu }) => {
      const { target, slice } = await universalTarget(
        fat([0x01000007, 0x0100000c]),
        host,
      );
      const config = parseConfig({ GHIDRA_INSTALL_DIR: "/simulated-ghidra" });
      if (!config.ok) throw config.error;
      const launches: { session: GhidraLaunchSession; bytes: Buffer }[] = [];
      const provider = new GhidraProvider(
        config.value,
        silentLogger,
        {},
        ghidraProfileInstallationHost,
        (options) =>
          new GhidraClient({
            ...options,
            launcher: {
              launch: async (session) => {
                const bytes = await readFile(session.targetPath);
                launches.push({ session, bytes });
                throw new Error("simulated launch stops after the import");
              },
            },
          }),
      );
      expect(provider.inspectTargetSupport(target).status).toBe("supported");
      const resolved = await provider.resolveAnalysisProfile(target);
      if (!resolved.ok || resolved.value.profile === null)
        throw new Error("Expected simulated profile admission");
      const client = provider.createClient(target, resolved.value.profile);
      expect((await client.execute("health", {})).ok).toBe(false);
      await client.close();

      expect(launches).toHaveLength(1);
      const [{ session, bytes }] = launches as [(typeof launches)[0]];
      expect(bytes.equals(slice), "only the selected slice is imported").toBe(
        true,
      );
      expect(bytes.readUInt32BE(4)).toBe(cpu);
      expect(parseExecutableHeader(bytes, host).ok).toBe(true);
      expect(session.targetSha256).toBe(sha256(slice));
      expect(session.targetSha256).not.toBe(target.sha256);
      // The bridge maps its slice-local offsets to universal-file offsets.
      expect(session.targetFileOffsetBase).toBe(target.universalSlice.offset);
      expect(session.targetFileOffsetBase).toBeGreaterThan(0);
      await expect(access(session.targetPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.each([
    { name: "a middle slice", selected: 1 },
    { name: "the first slice", selected: 0 },
  ])(
    "copies exactly $name when later slices follow it across read boundaries",
    async ({ selected }) => {
      const arm64 = { cpu: 0x0100000c, size: 33464 };
      const x86_64 = { cpu: 0x01000007, size: 8480 };
      const layout =
        selected === 1
          ? [
              { ...x86_64, offset: 4096 },
              { ...arm64, offset: 16384 },
              { cpu: 0x00000007, offset: 65536, size: 33464 },
            ]
          : [
              { ...arm64, offset: 16384 },
              { ...x86_64, offset: 98304 },
            ];
      const bytes = largeUniversal(layout);
      const { directory, target, slice } = await universalTarget(
        bytes,
        "arm64",
      );
      const snapshot = await createGhidraTargetSnapshot(
        target.path,
        directory,
        target.sha256,
        { platform: "linux", slice: target.universalSlice },
      );
      const copied = await readFile(snapshot.path);
      expect(copied.length, "no byte after the slice is copied").toBe(
        arm64.size,
      );
      expect(copied.equals(slice)).toBe(true);
      expect(snapshot.sha256).toBe(sha256(slice));
    },
  );

  it("fails closed when the source changed or the slice leaves the file", async () => {
    const bytes = fat([0x01000007, 0x0100000c]);
    const { directory, target } = await universalTarget(bytes, "arm64");
    await expect(
      createGhidraTargetSnapshot(target.path, directory, "0".repeat(64), {
        platform: "linux",
        slice: target.universalSlice,
      }),
    ).rejects.toMatchObject({ _tag: "AnalysisArtifactChangedError" });
    await expect(
      createGhidraTargetSnapshot(target.path, directory, target.sha256, {
        platform: "linux",
        slice: { offset: target.universalSlice.offset, size: bytes.length },
      }),
    ).rejects.toMatchObject({ _tag: "AnalysisArtifactChangedError" });
    await expect(
      createGhidraTargetSnapshot(target.path, directory, target.sha256, {
        platform: "win32",
        slice: target.universalSlice,
      }),
    ).rejects.toThrow(/cannot thin a slice/u);
  });
});
