import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "vitest";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { readMipsElfMetadata } from "../../../src/application/MipsElfMetadata.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import {
  ghidraMipsProfileParameters,
  ghidraMipsUnsupportedReason,
} from "../../../src/ghidra/GhidraMipsProfile.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const relOffset = 4096;
const fixture = (little: boolean, count = 2): Buffer => {
  const bytes = Buffer.alloc(relOffset + count * 8 + 16);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 1, little ? 1 : 2, 1]);
  const u16 = (value: number, offset: number) =>
    little
      ? bytes.writeUInt16LE(value, offset)
      : bytes.writeUInt16BE(value, offset);
  const u32 = (value: number, offset: number) =>
    little
      ? bytes.writeUInt32LE(value, offset)
      : bytes.writeUInt32BE(value, offset);
  u16(3, 16);
  u16(8, 18);
  u32(1, 20);
  u32(52, 28);
  u32(0x74001005, 36);
  u16(52, 40);
  u16(32, 42);
  u16(2, 44);
  u32(1, 52);
  u32(bytes.length, 68);
  u32(bytes.length, 72);
  u32(2, 84);
  u32(256, 88);
  u32(256, 92);
  u32(32, 100);
  u32(32, 104);
  u32(17, 256);
  u32(relOffset, 260);
  u32(18, 264);
  u32(count * 8, 268);
  u32(19, 272);
  u32(8, 276);
  for (let i = 1; i < count; i += 1) {
    u32(512, relOffset + 8 * i);
    u32(3, relOffset + 8 * i + 4);
  }
  return bytes;
};
const resolve = async (bytes: Buffer) => {
  const directory = await createTestTempDirectory("rea-mips-shared-test-");
  const path = join(directory, "shared.elf");
  await writeFile(path, bytes);
  const result = await parseBinaryTarget(path);
  assert.ok(result.ok);
  assert.equal(result.value.kind, "executable");
  assert.equal(result.value.architecture, "mips");
  if (
    result.value.kind !== "executable" ||
    result.value.architecture !== "mips"
  )
    throw new Error("expected MIPS ELF");
  assert.equal(
    result.value.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.deepEqual(await readFile(path), bytes);
  return result.value;
};

for (const little of [true, false]) {
  it(`retains complete dynamic declarations beyond the initial probe (${little ? "LE" : "BE"})`, async () => {
    const target = await resolve(fixture(little));
    assert.equal(target.mips.abiFlags, null);
    assert.deepEqual(target.mips.sharedLoad, {
      status: "complete",
      relocationCount: 2,
      relocationTypes: [0, 3],
      symbolRelativeCount: 0,
    });
    assert.equal(ghidraMipsUnsupportedReason(target), null);
    assert.deepEqual(ghidraMipsProfileParameters(target).mips_elf, {
      elf_class: 32,
      byte_order: little ? "little" : "big",
      type: 3,
      flags: 0x74001005,
      abi_flags: null,
      shared_load: {
        status: "complete",
        relocation_count: 2,
        relocation_types: [0, 3],
        symbol_relative_count: 0,
      },
    });
  });
  it(`retains and refuses symbol-bearing REL32 without repairing the mode tag (${little ? "LE" : "BE"})`, async () => {
    const bytes = fixture(little);
    if (little) bytes.writeUInt32LE(0x103, relOffset + 12);
    else bytes.writeUInt32BE(0x103, relOffset + 12);
    const target = await resolve(bytes);
    assert.equal(target.mips.sharedLoad?.status, "complete");
    assert.match(
      ghidraMipsUnsupportedReason(target) ?? "",
      /Symbol-bearing R_MIPS_REL32/u,
    );
  });
}

it("examines relocation records beyond a read chunk before deciding completeness", async () => {
  const count = 8194;
  const bytes = fixture(true, count);
  bytes.writeUInt32LE(0x103, relOffset + (count - 1) * 8 + 4);
  const target = await resolve(bytes);
  assert.deepEqual(target.mips.sharedLoad, {
    status: "complete",
    relocationCount: count,
    relocationTypes: [0, 3],
    symbolRelativeCount: 1,
  });
  assert.match(ghidraMipsUnsupportedReason(target) ?? "", /mode tag/u);
});

it("does not treat uncaptured ABI declaration headers as an inspected absence", async () => {
  const bytes = fixture(true);
  bytes.writeUInt32LE(bytes.length + 1, 32);
  bytes.writeUInt16LE(40, 46);
  bytes.writeUInt16LE(1, 48);
  const target = await resolve(bytes);
  assert.equal(target.mips.abiFlags, null);
  assert.equal(target.mips.sharedLoad?.status, "unavailable");
  assert.match(
    ghidraMipsUnsupportedReason(target) ?? "",
    /unavailable headers remain unknown/u,
  );
});

const malformed: [string, (bytes: Buffer) => void, RegExp][] = [
  [
    "overlapping load ranges",
    (b) => {
      b.writeUInt16LE(3, 44);
      b.writeUInt32LE(1, 116);
      b.writeUInt32LE(256, 124);
      b.writeUInt32LE(16, 132);
      b.writeUInt32LE(16, 136);
    },
    /overlapping MIPS PT_LOAD/u,
  ],
  [
    "inconsistent dynamic address",
    (b) => b.writeUInt32LE(0x10000, 92),
    /matching file-backed PT_LOAD/u,
  ],
  ["missing dynamic table", (b) => b.writeUInt32LE(0, 84), /no PT_DYNAMIC/u],
  ["repeated dynamic tables", (b) => b.writeUInt32LE(2, 52), /duplicate/u],
  [
    "declared dynamic tail outside file",
    (b) => b.writeUInt32LE(b.length, 100),
    /beyond the file/u,
  ],
  [
    "unavailable load bytes",
    (b) => b.writeUInt32LE(b.length + 1, 68),
    /PT_LOAD range/u,
  ],
  ["missing terminator", (b) => b.writeUInt32LE(1, 280), /DT_NULL/u],
  [
    "repeated scalar tags",
    (b) => b.writeUInt32LE(17, 272),
    /duplicate MIPS dynamic tag/u,
  ],
  ["invalid REL entry size", (b) => b.writeUInt32LE(16, 276), /DT_RELENT/u],
  ["truncated REL record", (b) => b.writeUInt32LE(17, 268), /DT_RELENT/u],
  [
    "unmapped REL table",
    (b) => b.writeUInt32LE(0x10000, 260),
    /PT_LOAD mapping/u,
  ],
  [
    "unmapped REL destination",
    (b) => b.writeUInt32LE(0x10000, relOffset + 8),
    /PT_LOAD memory range/u,
  ],
  [
    "RELA declaration",
    (b) => {
      b.writeUInt32LE(7, 272);
      b.writeUInt32LE(4096, 276);
    },
    /RELA or PLT/u,
  ],
];
it.each(malformed)(
  "preserves useful partial header facts for %s",
  async (_name, mutate, reason) => {
    const bytes = fixture(true);
    mutate(bytes);
    const target = await resolve(bytes);
    assert.equal(target.mips.flags, 0x74001005);
    assert.equal(target.mips.abiFlags, null);
    assert.equal(target.mips.sharedLoad?.status, "unavailable");
    assert.match(ghidraMipsUnsupportedReason(target) ?? "", reason);
  },
);

it("retains unverified relocation type instead of claiming every examined record is supported", async () => {
  const bytes = fixture(true);
  bytes.writeUInt32LE(5, relOffset + 12);
  const target = await resolve(bytes);
  assert.deepEqual(target.mips.sharedLoad, {
    status: "complete",
    relocationCount: 2,
    relocationTypes: [0, 5],
    symbolRelativeCount: 0,
  });
  assert.match(
    ghidraMipsUnsupportedReason(target) ?? "",
    /other dynamic relocation types/u,
  );
});

it("does not equate complete dynamic REL coverage with coverage of another section relocation table", async () => {
  const bytes = fixture(true);
  bytes.writeUInt32LE(1024, 32);
  bytes.writeUInt16LE(40, 46);
  bytes.writeUInt16LE(1, 48);
  bytes.writeUInt32LE(9, 1028);
  bytes.writeUInt32LE(2048, 1040);
  bytes.writeUInt32LE(8, 1044);
  bytes.writeUInt32LE(8, 1060);
  const target = await resolve(bytes);
  assert.equal(target.mips.sharedLoad?.status, "unavailable");
  assert.match(
    ghidraMipsUnsupportedReason(target) ?? "",
    /section relocation declarations/u,
  );
});

it("preserves the caller cancellation error during a bounded relocation scan", async () => {
  const target = await resolve(fixture(true, 8194));
  const handle = await open(target.path, "r");
  const cancellation = new AnalysisCancelledError("open_binary");
  let checks = 0;
  try {
    await assert.rejects(
      readMipsElfMetadata(handle, target.mips, () => {
        checks += 1;
        if (checks === 100) throw cancellation;
      }),
      (error) => error === cancellation,
    );
  } finally {
    await handle.close();
  }
});
