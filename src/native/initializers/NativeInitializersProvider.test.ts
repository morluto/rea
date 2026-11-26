import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { aps2Table } from "../../../tests/fixtures/elfAndroidPacked.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { DEFAULT_NATIVE_STRUCTURE_BYTES } from "../../domain/binaryContainer.js";
import { inspectNativeInitializersInputSchema } from "../../domain/native/nativeInitializers.js";
import { NativeInitializersProvider } from "./NativeInitializersProvider.js";

const elf64WithAndroidPackedRela = (packed: Buffer): Buffer => {
  const file = Buffer.alloc(Math.max(0x600, 0x300 + packed.length));
  // ELF64 little-endian ET_DYN x86_64 header
  file.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  file.writeUInt16LE(3, 16);
  file.writeUInt16LE(62, 18);
  file.writeUInt32LE(1, 20);
  file.writeBigUInt64LE(64n, 32); // e_phoff
  file.writeUInt16LE(64, 52); // e_ehsize
  file.writeUInt16LE(56, 54); // e_phentsize
  file.writeUInt16LE(2, 56); // e_phnum

  // PT_LOAD covering the full file at VA 0
  file.writeUInt32LE(1, 64);
  file.writeUInt32LE(7, 68);
  file.writeBigUInt64LE(0n, 72);
  file.writeBigUInt64LE(0n, 80);
  file.writeBigUInt64LE(0n, 88);
  file.writeBigUInt64LE(BigInt(file.length), 96);
  file.writeBigUInt64LE(BigInt(file.length), 104);
  file.writeBigUInt64LE(1n, 112);

  // PT_DYNAMIC at 0x200 with 6 entries (96 bytes)
  const dynOffset = 0x200;
  file.writeUInt32LE(2, 120);
  file.writeUInt32LE(6, 124);
  file.writeBigUInt64LE(BigInt(dynOffset), 128);
  file.writeBigUInt64LE(BigInt(dynOffset), 136);
  file.writeBigUInt64LE(BigInt(dynOffset), 144);
  file.writeBigUInt64LE(96n, 152);
  file.writeBigUInt64LE(96n, 160);
  file.writeBigUInt64LE(1n, 168);

  const dynEntries: readonly [bigint, bigint][] = [
    [25n, 0x180n], // DT_INIT_ARRAY
    [27n, 8n], // DT_INIT_ARRAYSZ
    [0x60000011n, 0x300n], // DT_ANDROID_RELA
    [0x60000012n, BigInt(packed.length)], // DT_ANDROID_RELASZ
    [0n, 0n], // DT_NULL
  ];
  for (const [index, [tag, value]] of dynEntries.entries()) {
    const at = dynOffset + index * 16;
    file.writeBigInt64LE(tag, at);
    file.writeBigUInt64LE(value, at + 8);
  }
  packed.copy(file, 0x300);
  return file;
};

it("bounds Android APS2 packed relocation tables with max_structure_bytes and reports details.limit", async () => {
  const dir = await createTestTempDirectory("rea-native-init-aps2-");
  const target = join(dir, "aps2.so");
  // 100 RELA64 entries = 2,400 expanded bytes (exceeds 1,024, fits in 4,096).
  const packed = aps2Table([100, 0x180 - 8, 100, 15, 8, 8, 0x100]);
  await writeFile(target, elf64WithAndroidPackedRela(packed));
  const provider = new NativeInitializersProvider();
  try {
    const refused = await provider.inspect(
      inspectNativeInitializersInputSchema.parse({
        path: target,
        max_structure_bytes: 1024,
      }),
    );
    if (refused.ok) throw new Error("Expected a max_structure_bytes refusal");
    if (!(refused.error instanceof AnalysisResourceConstraintError))
      throw refused.error;
    expect(refused.error).toMatchObject({
      reportedLimits: {
        boundary: "max_structure_bytes",
        maximum: 1024,
      },
      limit: {
        control_kind: "parameter",
        parameter: "max_structure_bytes",
        effective_value: 1024,
        default_value: DEFAULT_NATIVE_STRUCTURE_BYTES,
        maximum: 512 * 1024 * 1024,
        applies_at: "next_call",
      },
    });
    expect(refused.error.fixedAllowance).toBeUndefined();

    const admitted = await provider.inspect(
      inspectNativeInitializersInputSchema.parse({
        path: target,
        max_structure_bytes: 4096,
      }),
    );
    if (!admitted.ok) throw admitted.error;
    expect(admitted.value.entries).toHaveLength(1);
    expect(admitted.value.entries[0]?.value_va).toBe("0x100");

    // Non-APS2 garbage exceeding max_structure_bytes remains malformed, not a budget refusal.
    const badPath = join(dir, "non-aps2.so");
    await writeFile(
      badPath,
      elf64WithAndroidPackedRela(Buffer.alloc(2048, 0x58)),
    );
    const malformed = await provider.inspect(
      inspectNativeInitializersInputSchema.parse({
        path: badPath,
        max_structure_bytes: 1024,
      }),
    );
    if (!malformed.ok) throw malformed.error;
    expect(malformed.value.status).toBe("incomplete");
    expect(
      malformed.value.limitations.some((line) =>
        line.includes("lacks an APS2 header"),
      ),
    ).toBe(true);

    // Omitting max_structure_bytes enforces the 16 MiB default and raising it admits >16 MiB tables.
    const largePath = join(dir, "aps2-large.so");
    const largeCount = 700_000; // 700,000 * 24 = 16,800,000 > 16 MiB
    const largePacked = aps2Table([
      largeCount,
      0x180 - 8,
      1,
      15,
      8,
      8,
      0x100,
      1,
      3,
      0x10,
      0,
      largeCount - 2,
      3,
      0,
      0,
    ]);
    await writeFile(largePath, elf64WithAndroidPackedRela(largePacked));
    const defaultRefused = await provider.inspect(
      inspectNativeInitializersInputSchema.parse({ path: largePath }),
    );
    if (defaultRefused.ok)
      throw new Error("Expected default 16 MiB max_structure_bytes refusal");
    if (!(defaultRefused.error instanceof AnalysisResourceConstraintError))
      throw defaultRefused.error;
    expect(defaultRefused.error).toMatchObject({
      reportedLimits: {
        boundary: "max_structure_bytes",
        maximum: DEFAULT_NATIVE_STRUCTURE_BYTES,
        required: largeCount * 24,
      },
      limit: {
        control_kind: "parameter",
        parameter: "max_structure_bytes",
        effective_value: DEFAULT_NATIVE_STRUCTURE_BYTES,
        default_value: DEFAULT_NATIVE_STRUCTURE_BYTES,
        maximum: 512 * 1024 * 1024,
        applies_at: "next_call",
      },
    });
    expect(defaultRefused.error.fixedAllowance).toBeUndefined();

    const raisedAdmitted = await provider.inspect(
      inspectNativeInitializersInputSchema.parse({
        path: largePath,
        max_structure_bytes: 32 * 1024 * 1024,
      }),
    );
    if (!raisedAdmitted.ok) throw raisedAdmitted.error;
    expect(raisedAdmitted.value.entries).toHaveLength(1);
    expect(raisedAdmitted.value.entries[0]?.value_va).toBe("0x100");
  } finally {
    await provider.close();
    await rm(dir, { recursive: true, force: true });
  }
});
