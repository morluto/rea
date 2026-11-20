import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { MachOSliceArtifactReader } from "../../../../src/artifacts/MachOSliceArtifactReader.js";
import {
  CPU,
  fatImage,
  machoImage,
} from "../../../../src/artifacts/apple/MachoImage.fixture.js";
import { ok } from "../../../../src/domain/result.js";
import type { NativeCommandRunner } from "../../../../src/providers/NativeCommandRunner.js";

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
    const reader = new MachOSliceArtifactReader(binary, {}, runner);
    onTestFinished(() => reader.close());
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
    const reader = new MachOSliceArtifactReader(binary, {}, runner);
    onTestFinished(() => reader.close());
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    expect(entries).toHaveLength(2);
    const firstEntry = entries[0];
    const secondEntry = entries[1];
    if (firstEntry === undefined || secondEntry === undefined)
      throw new Error("Expected both universal Mach-O slice entries");
    expect(secondEntry).toMatchObject({
      path: "slices/arm64",
      byteOffset: 8192,
      declaredSize: arm.length,
    });
    for (const adapterKey of ["0x2000:8", "1e3:8", " 8192 :8"])
      await expect(
        reader.open({ ...secondEntry, adapterKey }),
      ).rejects.toMatchObject({ reason: "integrity" });
    await expect(
      reader.open({ ...secondEntry, adapterKey: firstEntry.adapterKey }),
    ).rejects.toMatchObject({ reason: "integrity" });
    await expect(
      reader.open({ ...secondEntry, path: firstEntry.path }),
    ).rejects.toMatchObject({ reason: "integrity" });
    await expect(
      reader.open({ ...secondEntry, byteOffset: firstEntry.byteOffset }),
    ).rejects.toMatchObject({ reason: "integrity" });
    await expect(
      reader.open({ ...secondEntry, declaredSize: arm.length + 1 }),
    ).rejects.toMatchObject({ reason: "integrity" });
    const originalKey = secondEntry.adapterKey;
    Reflect.set(secondEntry, "adapterKey", firstEntry.adapterKey);
    await expect(reader.open(secondEntry)).rejects.toMatchObject({
      reason: "integrity",
    });
    Reflect.set(secondEntry, "adapterKey", originalKey);
    const chunks: Buffer[] = [];
    const stream = await reader.open({ ...secondEntry });
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.compare(Buffer.concat(chunks), Buffer.from(arm))).toBe(0);
    expect(reader.provenance()).toEqual([
      expect.objectContaining({ tool: "lipo", effects: ["read"] }),
    ]);
    const provenance = reader.provenance();
    if (provenance[0] !== undefined)
      Reflect.set(provenance[0], "tool", "forged");
    expect(reader.provenance()[0]?.tool).toBe("lipo");
  });
});

describe("artifact Mach-O slice integrity", () => {
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
        {},
        lipoRunner(`${details.join("\n")}\n`),
      );
      onTestFinished(() => reader.close());
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
      {},
      lipoRunner(
        `architecture arm64\n cputype 16777228\n cpusubtype 0\n offset 4096\n size ${thin.length}\n align 2^12 (4096)\n`,
      ),
    );
    onTestFinished(() => reader.close());
    await expect(async () => {
      for await (const _entry of reader.entries()) {
        // Malformed structural facts must fail before any slice is yielded.
      }
    }).rejects.toMatchObject({
      reason: "integrity",
      integrityCheck: "layout-consistency",
    });
  });

  // #4280: record-and-continue keeps going with REA's FAT parse as the authority.
  const disagreeingLipo = async (integrity: "fail" | "record-and-continue") => {
    const root = await createTestTempDirectory("rea-slices-record-");
    const binary = join(root, "fat");
    const x86 = machoImage({ cpu: CPU.x86_64 });
    const arm = machoImage({ cpu: CPU.arm64 });
    await writeFile(
      binary,
      fatImage([
        { cpu: CPU.x86_64, bytes: x86 },
        { cpu: CPU.arm64, bytes: arm },
      ]),
    );
    const reader = new MachOSliceArtifactReader(
      binary,
      {},
      // The arm64 row names a byte offset the FAT table does not.
      lipoRunner(
        `architecture x86_64\n cputype 16777223\n cpusubtype 3\n offset 4096\n size ${String(x86.length)}\n align 2^12 (4096)\narchitecture arm64\n cputype 16777228\n cpusubtype 0\n offset 8193\n size ${String(arm.length)}\n align 2^12 (4096)\n`,
      ),
      undefined,
      integrity,
    );
    onTestFinished(() => reader.close());
    const entries = [];
    const coverage: unknown[] = [];
    for await (const entry of reader.entries(undefined, {
      onCoverage: (observed) => coverage.push(observed),
    }))
      entries.push(entry);
    return { reader, entries, coverage, arm };
  };

  it("fails on a lipo/FAT disagreement under the default policy", async () => {
    await expect(disagreeingLipo("fail")).rejects.toMatchObject({
      reason: "integrity",
      integrityCheck: "layout-consistency",
    });
  });

  it("records a lipo/FAT disagreement and enumerates the FAT slices under record-and-continue", async () => {
    const { reader, entries, coverage, arm } = await disagreeingLipo(
      "record-and-continue",
    );
    expect(entries.map(({ path, byteOffset }) => [path, byteOffset])).toEqual([
      ["slices/x86_64", 4096],
      ["slices/arm64", 8192],
    ]);
    expect(coverage).toEqual([
      {
        status: "complete",
        limitations: [
          expect.stringMatching(
            /^Integrity limitation: lipo slice metadata disagrees with the Mach-O FAT table \(.*arm64.*offset=8193.*\)\. Slices were enumerated from REA's FAT table parse/u,
          ),
        ],
      },
    ]);
    const chunks: Buffer[] = [];
    const armEntry = entries[1];
    if (armEntry === undefined) throw new Error("Expected the arm64 slice");
    for await (const chunk of await reader.open(armEntry))
      chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.compare(Buffer.concat(chunks), Buffer.from(arm))).toBe(0);
  });
});

describe("artifact Mach-O slices under record-and-continue", () => {
  const recordedEntries = async (
    binaryBytes: Uint8Array,
    lipoStdout: string,
  ) => {
    const root = await createTestTempDirectory("rea-slices-record-");
    const binary = join(root, "fat");
    await writeFile(binary, binaryBytes);
    const reader = new MachOSliceArtifactReader(
      binary,
      {},
      lipoRunner(lipoStdout),
      undefined,
      "record-and-continue",
    );
    onTestFinished(() => reader.close());
    const entries = [];
    const coverage: { status: string; limitations: readonly string[] }[] = [];
    for await (const entry of reader.entries(undefined, {
      onCoverage: (observed) => coverage.push(observed),
    }))
      entries.push(entry);
    return { entries, coverage };
  };

  it("names recovered slices by their full CPU identity and keeps the paths distinct", async () => {
    const armv7 = { type: 12, subtype: 9 } as const;
    const armv7s = { type: 12, subtype: 11 } as const;
    const first = machoImage({ cpu: armv7, wide: false });
    const second = machoImage({ cpu: armv7s, wide: false });
    const third = machoImage({ cpu: armv7s, wide: false });
    // Both lipo rows name offsets the FAT table does not, so no row matches.
    const { entries } = await recordedEntries(
      fatImage([
        { cpu: armv7, bytes: first },
        { cpu: armv7s, bytes: second },
        { cpu: armv7s, bytes: third },
      ]),
      `architecture armv7\n cputype 12\n cpusubtype 9\n offset 4097\n size ${String(first.length)}\n align 2^12 (4096)\narchitecture armv7s\n cputype 12\n cpusubtype 11\n offset 8193\n size ${String(second.length)}\n align 2^12 (4096)\narchitecture armv7s\n cputype 12\n cpusubtype 11\n offset 12289\n size ${String(third.length)}\n align 2^12 (4096)\n`,
    );
    expect(entries.map(({ path }) => path)).toEqual([
      "slices/armv7",
      "slices/armv7s",
      "slices/armv7s@12288",
    ]);
  });

  it("keeps lipo's retained field evidence when the FAT table supplies the ranges", async () => {
    const x86 = machoImage({ cpu: CPU.x86_64 });
    const arm = machoImage({ cpu: CPU.arm64 });
    // The x86_64 row matches the FAT table but its alignment is unreadable;
    // the arm64 row disagrees and also has an unreadable alignment.
    const { entries, coverage } = await recordedEntries(
      fatImage([
        { cpu: CPU.x86_64, bytes: x86 },
        { cpu: CPU.arm64, bytes: arm },
      ]),
      `architecture x86_64\n cputype 16777223\n cpusubtype 3\n offset 4096\n size ${String(x86.length)}\n align 2^x\narchitecture arm64\n cputype 16777228\n cpusubtype 0\n offset 8193\n size ${String(arm.length)}\n align 2^y\n`,
    );
    expect(entries.map(({ path, limitations }) => [path, limitations])).toEqual(
      [
        [
          "slices/x86_64",
          [
            "lipo align for x86_64 could not be interpreted; source line:  align 2^x",
          ],
        ],
        ["slices/arm64", []],
      ],
    );
    expect(coverage).toEqual([
      {
        status: "complete",
        limitations: [
          expect.stringMatching(/^Integrity limitation: lipo slice metadata/u),
          "lipo align for arm64 could not be interpreted; source line:  align 2^y",
        ],
      },
    ]);
  });

  it("keeps lipo's unnormalized CPU declarations on a matched slice", async () => {
    const x86 = machoImage({ cpu: CPU.x86_64 });
    const arm = machoImage({ cpu: CPU.arm64 });
    const { entries } = await recordedEntries(
      fatImage([
        { cpu: CPU.x86_64, bytes: x86 },
        { cpu: CPU.arm64, bytes: arm },
      ]),
      `architecture x86_64\n cputype 16777223\n cpusubtype CPU_SUBTYPE_MYSTERY\n offset 4096\n size ${String(x86.length)}\n align 2^12 (4096)\narchitecture arm64\n cputype 16777228\n cpusubtype 0\n offset 8193\n size ${String(arm.length)}\n align 2^12 (4096)\n`,
    );
    expect(entries[0]).toMatchObject({
      path: "slices/x86_64",
      limitations: [
        "lipo CPU subtype is retained as unnormalized source text: CPU_SUBTYPE_MYSTERY",
      ],
    });
  });

  it("reports unknown coverage when lipo's counts disagree and no FAT parse is available", async () => {
    // A big-endian 32-bit Mach-O header: REA's structural reader declines it.
    const powerpc = new Uint8Array(4096);
    const view = new DataView(powerpc.buffer);
    view.setUint32(0, 0xfeedface, false);
    view.setUint32(4, 18, false);
    const { entries, coverage } = await recordedEntries(
      fatImage([{ cpu: { type: 18, subtype: 0 }, bytes: powerpc }]),
      `Fat header in: fat\nfat_magic 0xcafebabe\nnfat_arch 2\narchitecture ppc\n cputype 18\n cpusubtype 0\n offset 4096\n size 4096\n align 2^12 (4096)\n`,
    );
    expect(entries.map(({ path }) => path)).toEqual(["slices/ppc"]);
    expect(coverage).toEqual([
      {
        status: "unknown",
        limitations: [
          expect.stringMatching(
            /^Integrity limitation: lipo's architecture counts disagree.*may be incomplete\.$/u,
          ),
        ],
      },
    ]);
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
  // CPU_SUBTYPE_ARM64E_X1 (12) with the pointer-auth ABI bit, as in macOS 27 /bin/ls.
  const ARM64E_X1 = { type: 0x0100000c, subtype: 0x8000000c } as const;
  const numericX1 = "(cputype (16777228) cpusubtype (12))";
  const userspaceX1 =
    " cputype (16777228)\n cpusubtype cpusubtype (12)\n capabilities PTR_AUTH_VERSION USERSPACE 0";
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
      {},
      lipoRunner(
        `architecture x86_64\n cputype CPU_TYPE_X86_64\n cpusubtype CPU_SUBTYPE_X86_64_ALL\n offset 4096\n size ${String(x86.length)}\n align 2^12 (4096)\n${lipo(arm.length)}`,
      ),
    );
    onTestFinished(() => reader.close());
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    return entries.map(({ path, byteOffset }) => [path, byteOffset]);
  };

  it.each([
    [
      "arm64e.v1",
      ARM64E_V1,
      " cputype CPU_TYPE_ARM64\n cpusubtype CPU_SUBTYPE_ARM64E\n capabilities PTR_AUTH_VERSION USERSPACE 1",
    ],
    [
      "arm64e.x1",
      ARM64E_X1,
      " cputype CPU_TYPE_ARM64\n cpusubtype unknown arm64 cpusubtype",
    ],
    [
      "arm64e",
      ARM64E_V1,
      " cputype CPU_TYPE_ARM64\n cpusubtype CPU_SUBTYPE_ARM64E\n capabilities PTR_AUTH_VERSION USERSPACE 0",
    ],
    [numericX1, ARM64E_X1, userspaceX1],
    [numericX1, { ...ARM64E_X1, subtype: 0x8100000c }, userspaceX1],
    [
      numericX1,
      { ...ARM64E_X1, subtype: 0xc100000c },
      userspaceX1.replace("USERSPACE", "KERNEL"),
    ],
  ])(
    "accepts lipo's %s name for the FAT arm64e slice",
    async (name, fatCpu, cpu) => {
      expect(
        await variantSlices(
          fatCpu,
          (size) =>
            `architecture ${name}\n${cpu}\n offset 8192\n size ${String(size)}\n align 2^12 (4096)\n`,
        ),
      ).toEqual([
        ["slices/x86_64", 4096],
        [`slices/${name}`, 8192],
      ]);
    },
  );

  it.each([
    {
      reason: "architecture label",
      name: "(cputype (16777228) cpusubtype (2))",
    },
    { reason: "subtype field", subtype: "2" },
    { reason: "exact capabilities field", capabilities: "0x0" },
    { reason: "missing ABI flag", fatSubtype: 12 },
    { reason: "kernel ABI flag", fatSubtype: 0xc000000c },
  ])(
    "refuses a conflicting numeric lipo $reason",
    async ({
      name = numericX1,
      subtype = "12",
      capabilities = "PTR_AUTH_VERSION USERSPACE 0",
      fatSubtype = ARM64E_X1.subtype,
    }) => {
      await expect(
        variantSlices(
          { ...ARM64E_X1, subtype: fatSubtype },
          (size) =>
            `architecture ${name}\n cputype (16777228)\n cpusubtype cpusubtype (${subtype})\n capabilities ${capabilities}\n offset 8192\n size ${String(size)}\n align 2^12 (4096)\n`,
        ),
      ).rejects.toMatchObject({ reason: "integrity" });
    },
  );

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

// macOS 26 lipo leaves capabilities blank, even for a LIB64 x86_64 slice.
describe("artifact Mach-O LIB64 slices", () => {
  const LIB64 = { type: 0x01000007, subtype: 0x80000003 } as const;
  const lib64Slices = async (x86Subtype: string) => {
    const root = await createTestTempDirectory("rea-slices-lib64-");
    const binary = join(root, "fat");
    const x86 = machoImage({ cpu: LIB64 });
    const arm = machoImage({ cpu: CPU.arm64 });
    await writeFile(
      binary,
      fatImage([
        { cpu: LIB64, bytes: x86 },
        { cpu: CPU.arm64, bytes: arm },
      ]),
    );
    const reader = new MachOSliceArtifactReader(
      binary,
      {},
      lipoRunner(
        [
          "architecture x86_64",
          " cputype CPU_TYPE_X86_64",
          ` cpusubtype ${x86Subtype}`,
          " capabilities ",
          " offset 4096",
          ` size ${String(x86.length)}`,
          " align 2^12 (4096)",
          "architecture arm64",
          " cputype CPU_TYPE_ARM64",
          " cpusubtype CPU_SUBTYPE_ARM64_ALL",
          " capabilities ",
          " offset 8192",
          ` size ${String(arm.length)}`,
          " align 2^12 (4096)",
          "",
        ].join("\n"),
      ),
    );
    onTestFinished(() => reader.close());
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    return entries.map(({ path, byteOffset }) => [path, byteOffset]);
  };

  it("matches an x86_64 LIB64 slice whose lipo capabilities are blank", async () => {
    expect(await lib64Slices("CPU_SUBTYPE_X86_ALL")).toEqual([
      ["slices/x86_64", 4096],
      ["slices/arm64", 8192],
    ]);
  });

  it("still rejects a blank-capability subtype that names other bits", async () => {
    await expect(lib64Slices("CPU_SUBTYPE_X86_64_H")).rejects.toMatchObject({
      reason: "integrity",
    });
  });
});
