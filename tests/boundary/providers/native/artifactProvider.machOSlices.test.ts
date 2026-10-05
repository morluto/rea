import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { MachOSliceArtifactReader } from "../../../../src/artifacts/MachOSliceArtifactReader.js";
import { ok } from "../../../../src/domain/result.js";
import type { NativeCommandRunner } from "../../../../src/native/CommandRunner.js";

describe("artifact Mach-O slices", () => {
  it("rejects lipo slice sizes that exceed the observed artifact bytes", async () => {
    const root = await createTestTempDirectory("rea-slices-short-");
    const binary = join(root, "fat");
    await writeFile(binary, Buffer.from("0123456789"));
    const runner: NativeCommandRunner = {
      run: () =>
        Promise.resolve(
          ok({
            tool: "lipo",
            executable: "/usr/bin/lipo",
            executableSha256: "1".repeat(64),
            toolVersion: null,
            versionReason: "fixture",
            arguments: ["-detailed_info", binary],
            stdout:
              "architecture arm64\n cputype 16777228\n cpusubtype 0\n offset 0\n size 100\n align 2^2\n",
            stderr: "",
            stdoutBytes: 1,
            stderrBytes: 0,
            exitCode: 0,
            signal: null,
          }),
        ),
    };
    const reader = new MachOSliceArtifactReader(binary, runner);
    const enumerate = async (): Promise<void> => {
      for await (const _entry of reader.entries()) {
        // Enumeration must reject out-of-bounds lipo metadata before yielding.
      }
    };
    await expect(enumerate()).rejects.toMatchObject({ reason: "integrity" });
  });

  it("uses lipo metadata to read universal slice ranges", async () => {
    const root = await createTestTempDirectory("rea-slices-");
    const binary = join(root, "fat");
    await writeFile(binary, Buffer.from("0123456789abcdef"));
    const runner: NativeCommandRunner = {
      run: () =>
        Promise.resolve(
          ok({
            tool: "lipo",
            executable: "/usr/bin/lipo",
            executableSha256: "1".repeat(64),
            toolVersion: null,
            versionReason: "fixture",
            arguments: ["-detailed_info", binary],
            stdout:
              "architecture x86_64\n cputype 16777223\n cpusubtype 3\n offset 0\n size 8\n align 2^2\narchitecture arm64\n cputype 16777228\n cpusubtype 0\n offset 8\n size 8\n align 2^2\n",
            stderr: "",
            stdoutBytes: 1,
            stderrBytes: 0,
            exitCode: 0,
            signal: null,
          }),
        ),
    };
    const reader = new MachOSliceArtifactReader(binary, runner);
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    expect(entries).toHaveLength(2);
    const secondEntry = entries[1];
    expect(secondEntry).toBeDefined();
    if (secondEntry === undefined) return;
    expect(secondEntry).toMatchObject({
      path: "slices/arm64",
      byteOffset: 8,
      declaredSize: 8,
    });
    for (const adapterKey of ["0x8:8", "1e3:8", " 8 :8"])
      await expect(
        reader.open({ ...secondEntry, adapterKey }),
      ).rejects.toMatchObject({ reason: "integrity" });
    const chunks: Buffer[] = [];
    const stream = await reader.open(secondEntry);
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("89abcdef");
    expect(reader.provenance()).toEqual([
      expect.objectContaining({ tool: "lipo", effects: ["read"] }),
    ]);
    const provenance = reader.provenance();
    if (provenance[0] !== undefined)
      Reflect.set(provenance[0], "tool", "forged");
    expect(reader.provenance()[0]?.tool).toBe("lipo");
  });
});
