import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "vitest";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import type { MipsElfMetadata } from "../../../src/domain/binaryTargetTypes.js";
import { readMipsElfAbiFlags } from "../../../src/application/MipsElfAbiFlags.js";
import {
  ghidraMipsProfileParameters,
  ghidraMipsUnsupportedReason,
} from "../../../src/ghidra/GhidraMipsProfile.js";

const metadata = (little = true): MipsElfMetadata => ({
  elfClass: 32,
  byteOrder: little ? "little" : "big",
  type: 2,
  flags: 0x70001001,
});
const abiOffset = 8192; // Deliberately outside BinaryTargetResolver's 4 KiB probe.
const fixture = (little = true): Buffer => {
  const bytes = Buffer.alloc(abiOffset + 48);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 1, little ? 1 : 2, 1]);
  const u16 = (value: number, offset: number) =>
    little
      ? bytes.writeUInt16LE(value, offset)
      : bytes.writeUInt16BE(value, offset);
  const u32 = (value: number, offset: number) =>
    little
      ? bytes.writeUInt32LE(value, offset)
      : bytes.writeUInt32BE(value, offset);
  u16(2, 16);
  u16(8, 18);
  u32(1, 20);
  u32(52, 28);
  u32(128, 32);
  u32(0x70001001, 36);
  u16(52, 40);
  u16(32, 42);
  u16(1, 44);
  u16(40, 46);
  u16(2, 48);
  u32(0x70000003, 52);
  u32(abiOffset, 56);
  u32(24, 68);
  u32(24, 72);
  u32(0x7000002a, 172);
  u32(abiOffset, 184);
  u32(24, 188);
  bytes.set([0, 0, 32, 2, 1, 1, 0, 5], abiOffset);
  return bytes;
};
const inspect = async (
  bytes: Buffer,
  little = true,
  checkCancelled: () => void = () => {},
) => {
  const directory = await createTestTempDirectory("rea-mips-abi-test-");
  const path = join(directory, "fixture.elf");
  await writeFile(path, bytes);
  const handle = await open(path, "r");
  try {
    return await readMipsElfAbiFlags(handle, metadata(little), checkCancelled);
  } finally {
    await handle.close();
  }
};
const target = (mips: MipsElfMetadata) => ({
  path: "/fixture.elf",
  sha256: "a".repeat(64),
  kind: "executable" as const,
  format: "elf" as const,
  architecture: "mips" as const,
  availableArchitectures: ["mips"] as const,
  mips,
});

for (const little of [true, false]) {
  it(`reads a remote ABI record through both ELF tables (${little ? "LE" : "BE"})`, async () => {
    const bytes = fixture(little);
    const result = await inspect(bytes, little);
    assert.ok(result.ok);
    assert.deepEqual(result.value, {
      version: 0,
      isaLevel: 32,
      isaRevision: 2,
      gprSize: 1,
      cpr1Size: 1,
      cpr2Size: 0,
      fpAbi: 5,
      isaExtension: 0,
      ases: 0,
      flags1: 0,
      flags2: 0,
    });
    const resolved = target({ ...metadata(little), abiFlags: result.value });
    assert.equal(ghidraMipsUnsupportedReason(resolved), null);
    const before = ghidraMipsProfileParameters(resolved);
    bytes[abiOffset + 5] = 2;
    bytes[abiOffset + 7] = 6;
    const fp64 = await inspect(bytes, little);
    assert.ok(fp64.ok);
    const changed = target({ ...metadata(little), abiFlags: fp64.value });
    assert.match(ghidraMipsUnsupportedReason(changed) ?? "", /register modes/u);
    assert.notDeepEqual(ghidraMipsProfileParameters(changed), before);
  });
}

it("supports stripped section tables using PT_MIPS_ABIFLAGS", async () => {
  const bytes = fixture();
  bytes.writeUInt32LE(0, 32);
  bytes.writeUInt16LE(0, 48);
  const result = await inspect(bytes);
  assert.ok(result.ok);
  assert.equal(result.value?.fpAbi, 5);
});
it("supports a section-only ABI record without assuming its name", async () => {
  const bytes = fixture();
  bytes.writeUInt32LE(0, 28);
  bytes.writeUInt16LE(0, 44);
  const result = await inspect(bytes);
  assert.ok(result.ok);
  assert.equal(result.value?.fpAbi, 5);
});
it("keeps absent ABI declarations unknown and refuses provider admission", async () => {
  const bytes = fixture();
  bytes.writeUInt32LE(0, 52);
  bytes.writeUInt32LE(0, 172);
  const result = await inspect(bytes);
  assert.ok(result.ok);
  assert.equal(result.value, null);
  assert.match(
    ghidraMipsUnsupportedReason(target({ ...metadata(), abiFlags: null })) ??
      "",
    /inspected ABI/u,
  );
  assert.match(
    ghidraMipsUnsupportedReason(target(metadata())) ?? "",
    /inspected ABI/u,
  );
});
it("rejects contradictory program and section ABI declarations", async () => {
  const bytes = fixture();
  bytes.copy(bytes, abiOffset + 24, abiOffset, abiOffset + 24);
  bytes[abiOffset + 24 + 7] = 6;
  bytes.writeUInt32LE(abiOffset + 24, 184);
  const result = await inspect(bytes);
  assert.ok(!result.ok);
  assert.match(result.error, /conflicting/u);
});
it("rejects duplicate ABI declarations in one table", async () => {
  const bytes = fixture();
  bytes.copy(bytes, 84, 52, 84);
  bytes.writeUInt16LE(2, 44);
  const result = await inspect(bytes);
  assert.ok(!result.ok);
  assert.match(result.error, /duplicate/u);
});
const malformed: [string, (bytes: Buffer) => void, RegExp][] = [
  ["record outside file", (b) => b.writeUInt32LE(0xfffffff0, 56), /outside/u],
  ["table outside file", (b) => b.writeUInt32LE(0xfffffff0, 28), /outside/u],
  ["short record", (b) => b.writeUInt32LE(23, 68), /record size/u],
  ["oversized record", (b) => b.writeUInt32LE(0xffffffff, 68), /record size/u],
  ["invalid table stride", (b) => b.writeUInt16LE(31, 42), /entry size/u],
  ["extended program count", (b) => b.writeUInt16LE(0xffff, 44), /numbering/u],
  ["extended section count", (b) => b.writeUInt16LE(0, 48), /extended/u],
  ["changed identity", (b) => b.writeUInt32LE(0x60001001, 36), /identity/u],
  ["invalid ELF version", (b) => b.writeUInt32LE(0, 20), /version/u],
];
for (const [name, change, reason] of malformed) {
  it(`rejects ${name} instead of using a guessed ABI`, async () => {
    const bytes = fixture();
    change(bytes);
    const result = await inspect(bytes);
    assert.ok(!result.ok);
    assert.match(result.error, reason);
  });
}
const unsupported: [string, (bytes: Buffer) => void, RegExp][] = [
  ["new record version", (b) => b.writeUInt16LE(1, abiOffset), /version 0/u],
  [
    "conflicting ISA",
    (b) => {
      b[abiOffset + 3] = 6;
    },
    /MIPS32r2/u,
  ],
  [
    "soft-float",
    (b) => {
      b[abiOffset + 5] = 0;
      b[abiOffset + 7] = 3;
    },
    /register modes/u,
  ],
  [
    "unspecified FP ABI",
    (b) => {
      b[abiOffset + 7] = 0;
    },
    /unspecified/u,
  ],
  ["ISA extension", (b) => b.writeUInt32LE(1, abiOffset + 8), /extension/u],
  ["ASE", (b) => b.writeUInt32LE(0x800, abiOffset + 12), /ASE/u],
  [
    "reserved flags",
    (b) => b.writeUInt32LE(2, abiOffset + 16),
    /general flags/u,
  ],
];
for (const [name, change, reason] of unsupported) {
  it(`retains ${name} while rejecting its unverified provider interpretation`, async () => {
    const bytes = fixture();
    change(bytes);
    const result = await inspect(bytes);
    assert.ok(result.ok);
    assert.ok(result.value !== null);
    assert.match(
      ghidraMipsUnsupportedReason(
        target({ ...metadata(), abiFlags: result.value }),
      ) ?? "",
      reason,
    );
  });
}
it("preserves the caller's cancellation error during table inspection", async () => {
  const cancelled = new Error("caller cancellation sentinel");
  let checks = 0;
  await assert.rejects(
    inspect(fixture(), true, () => {
      checks += 1;
      if (checks === 12) throw cancelled;
    }),
    (error) => error === cancelled,
  );
});

for (const little of [true, false]) {
  it(`resolves full-file MIPS ABI identity before provider selection (${little ? "LE" : "BE"})`, async () => {
    const directory = await createTestTempDirectory("rea-mips-resolution-");
    const path = join(directory, "fixture.elf");
    const bytes = fixture(little);
    await writeFile(path, bytes);
    const result = await parseBinaryTarget(path);
    if (!result.ok) throw result.error;
    assert.equal(result.value.architecture, "mips");
    assert.equal(result.value.format, "elf");
    assert.equal(
      result.value.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    if (
      result.value.kind !== "executable" ||
      result.value.architecture !== "mips"
    )
      throw new Error("Expected a resolved MIPS executable");
    assert.equal(result.value.mips.byteOrder, little ? "little" : "big");
    assert.equal(result.value.mips.abiFlags?.fpAbi, 5);
    assert.equal(ghidraMipsUnsupportedReason(result.value), null);
    assert.deepEqual(await readFile(path), bytes);
  });
}

it("keeps missing ABI data unknown through the public target resolver", async () => {
  const directory = await createTestTempDirectory("rea-mips-resolution-");
  const path = join(directory, "fixture.elf");
  const bytes = fixture();
  bytes.writeUInt32LE(0, 52);
  bytes.writeUInt32LE(0, 172);
  await writeFile(path, bytes);
  const result = await parseBinaryTarget(path);
  if (!result.ok) throw result.error;
  if (
    result.value.kind !== "executable" ||
    result.value.architecture !== "mips"
  )
    throw new Error("Expected a resolved MIPS executable");
  assert.equal(result.value.mips.abiFlags, null);
  assert.match(
    ghidraMipsUnsupportedReason(result.value) ?? "",
    /inspected ABI/u,
  );
});

it("projects a malformed out-of-probe ABI record as a target error", async () => {
  const directory = await createTestTempDirectory("rea-mips-resolution-");
  const path = join(directory, "fixture.elf");
  const bytes = fixture();
  bytes.writeUInt32LE(0xfffffff0, 56);
  await writeFile(path, bytes);
  const result = await parseBinaryTarget(path);
  if (result.ok) throw new Error("Malformed ABI extent was accepted");
  assert.equal(result.error._tag, "BinaryTargetError");
  assert.match(result.error.message, /ABI record lies outside the file/u);
  assert.deepEqual(await readFile(path), bytes);
});

it("preserves cancellation instead of turning it into malformed target data", async () => {
  const directory = await createTestTempDirectory("rea-mips-resolution-");
  const path = join(directory, "fixture.elf");
  await writeFile(path, fixture());
  const controller = new AbortController();
  controller.abort();
  const result = await parseBinaryTarget(path, { signal: controller.signal });
  if (result.ok) throw new Error("Cancelled target resolution succeeded");
  assert.ok(result.error instanceof AnalysisCancelledError);
});
