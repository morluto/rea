import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { MachOSliceArtifactReader } from "../../../../src/artifacts/MachOSliceArtifactReader.js";
import {
  CPU,
  fatImage,
  machoImage,
} from "../../../../src/artifacts/apple/MachoImage.fixture.js";
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
    const x86 = machoImage({ cpu: CPU.x86_64 });
    const arm = machoImage({ cpu: CPU.arm64 });
    const image = fatImage([
      { cpu: CPU.x86_64, bytes: x86 },
      { cpu: CPU.arm64, bytes: arm },
    ]);
    await writeFile(binary, image);
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
            stdout: `architecture x86_64\n cputype 16777223\n cpusubtype 3\n offset 4096\n size ${x86.length}\n align 2^12\narchitecture arm64\n cputype 16777228\n cpusubtype 0\n offset 8192\n size ${arm.length}\n align 2^12\n`,
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
      byteOffset: 8192,
      declaredSize: arm.length,
    });
    for (const adapterKey of ["0x2000:8", "1e3:8", " 8192 :8"])
      await expect(
        reader.open({ ...secondEntry, adapterKey }),
      ).rejects.toMatchObject({ reason: "integrity" });
    const chunks: Buffer[] = [];
    const stream = await reader.open(secondEntry);
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(arm));
    expect(reader.provenance()).toEqual([
      expect.objectContaining({ tool: "lipo", effects: ["read"] }),
    ]);
    const provenance = reader.provenance();
    if (provenance[0] !== undefined)
      Reflect.set(provenance[0], "tool", "forged");
    expect(reader.provenance()[0]?.tool).toBe("lipo");
  });

  it.each([
    ["CPU type", "cputype 16777223"],
    ["CPU subtype", "cpusubtype 2"],
    ["alignment", "align 2^11 (2048)"],
    ["offset", "offset 4097"],
  ])(
    "rejects lipo %s that disagrees with physical Mach-O facts",
    async (_label, field) => {
      const root = await createTestTempDirectory("rea-slices-mismatch-");
      const binary = join(root, "fat");
      const thin = machoImage({ cpu: CPU.arm64 });
      await writeFile(binary, fatImage([{ cpu: CPU.arm64, bytes: thin }]));
      const details = [
        "architecture arm64",
        " cputype 16777228",
        " cpusubtype 0",
        " offset 4096",
        ` size ${thin.length}`,
        " align 2^12 (4096)",
      ];
      const index = field.startsWith("cputype")
        ? 1
        : field.startsWith("cpusubtype")
          ? 2
          : field.startsWith("align")
            ? 5
            : 3;
      details[index] = ` ${field}`;
      const reader = new MachOSliceArtifactReader(
        binary,
        lipoRunner(`${details.join("\n")}\n`),
      );
      await expect(async () => {
        for await (const _entry of reader.entries()) {
          // The structural comparison runs before the reader yields a slice.
        }
      }).rejects.toMatchObject({ reason: "integrity" });
    },
  );

  it("does not trust lipo after a malformed structural Mach-O parse", async () => {
    const root = await createTestTempDirectory("rea-slices-malformed-");
    const binary = join(root, "fat");
    const thin = machoImage({ cpu: CPU.arm64 });
    new DataView(thin.buffer).setUint32(16, 1, true);
    const image = fatImage([{ cpu: CPU.arm64, bytes: thin }]);
    await writeFile(binary, image);
    const reader = new MachOSliceArtifactReader(
      binary,
      lipoRunner(
        `architecture arm64\n cputype 16777228\n cpusubtype 0\n offset 4096\n size ${thin.length}\n align 2^12 (4096)\n`,
      ),
    );
    await expect(async () => {
      for await (const _entry of reader.entries()) {
        // Malformed structural facts must fail before any slice is yielded.
      }
    }).rejects.toThrow(/structural slice index is malformed/u);
  });
});

const lipoRunner = (stdout: string): NativeCommandRunner => ({
  run: () =>
    Promise.resolve(
      ok({
        tool: "lipo",
        executable: "/usr/bin/lipo",
        executableSha256: "1".repeat(64),
        toolVersion: null,
        versionReason: "fixture",
        arguments: ["-detailed_info", "fixture"],
        stdout,
        stderr: "",
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: 0,
        exitCode: 0,
        signal: null,
      }),
    ),
});

// Newer lipo names arm64e ABI variants `arm64e.<variant>`; the FAT table names
// the same slice `arm64e`, and its physical identity must still match.
describe("artifact Mach-O arm64e variant slices", () => {
  const ARM64E_V1 = { type: 0x0100000c, subtype: 0x81000002 } as const;
  const variantSlices = async (
    cpu: { readonly type: number; readonly subtype: number },
    lipo: (size: number) => string,
  ) => {
    const root = await createTestTempDirectory("rea-slices-arm64e-");
    const binary = join(root, "fat");
    const x86 = machoImage({ cpu: CPU.x86_64 });
    const arm = machoImage({ cpu });
    await writeFile(
      binary,
      fatImage([
        { cpu: CPU.x86_64, bytes: x86 },
        { cpu, bytes: arm },
      ]),
    );
    const reader = new MachOSliceArtifactReader(
      binary,
      lipoRunner(
        `architecture x86_64\n cputype CPU_TYPE_X86_64\n cpusubtype CPU_SUBTYPE_X86_64_ALL\n offset 4096\n size ${String(x86.length)}\n align 2^12 (4096)\n${lipo(arm.length)}`,
      ),
    );
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    return entries.map(({ path, byteOffset }) => [path, byteOffset]);
  };

  it.each([
    [
      "arm64e.v1",
      " cputype CPU_TYPE_ARM64\n cpusubtype CPU_SUBTYPE_ARM64E\n capabilities PTR_AUTH_VERSION USERSPACE 1",
    ],
    [
      "arm64e.x1",
      " cputype CPU_TYPE_ARM64\n cpusubtype unknown arm64 cpusubtype",
    ],
  ])("accepts lipo's %s name for the FAT arm64e slice", async (name, cpu) => {
    expect(
      await variantSlices(
        ARM64E_V1,
        (size) =>
          `architecture ${name}\n${cpu}\n offset 8192\n size ${String(size)}\n align 2^12 (4096)\n`,
      ),
    ).toEqual([
      ["slices/x86_64", 4096],
      [`slices/${name}`, 8192],
    ]);
  });

  it.each([
    ["a plain arm64 slice", CPU.arm64, "8192"],
    ["a different offset", ARM64E_V1, "8193"],
  ])(
    "still rejects an arm64e variant name for %s",
    async (_label, cpu, offset) => {
      await expect(
        variantSlices(
          cpu,
          (size) =>
            `architecture arm64e.v1\n cputype CPU_TYPE_ARM64\n cpusubtype unknown arm64 cpusubtype\n offset ${offset}\n size ${String(size)}\n align 2^12 (4096)\n`,
        ),
      ).rejects.toMatchObject({ reason: "integrity" });
    },
  );
});
