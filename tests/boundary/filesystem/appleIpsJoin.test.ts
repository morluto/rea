import { createHash } from "node:crypto";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import {
  appleIpsReportIntegerTextBytes,
  appleIpsSchema,
} from "../../../src/domain/native/appleIps.js";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createAppleIpsService } from "../../../src/composition/binaryDiagnostics.js";
import { appleIpsBytes } from "../../fixtures/binaryDiagnostics/appleIps.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const FIXTURE_UUID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const OTHER_UUID = "CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC";
const ARM64 = { type: 0x0100000c, subtype: 0 } as const;
const X86_64 = { type: 0x01000007, subtype: 3 } as const;

interface SliceSpec {
  readonly cpu: { readonly type: number; readonly subtype: number };
  readonly uuid: string | null;
  readonly textVmaddr: bigint;
  readonly withText?: boolean;
}

const commandBytes = (commands: readonly Buffer[]): Buffer => {
  const total = commands.reduce((sum, command) => sum + command.length, 0);
  const body = Buffer.alloc(total);
  let offset = 0;
  for (const command of commands) {
    command.copy(body, offset);
    offset += command.length;
  }
  return body;
};

const uuidCommand = (uuid: string): Buffer => {
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32LE(0x1b, 0);
  bytes.writeUInt32LE(24, 4);
  Buffer.from(uuid.replaceAll("-", ""), "hex").copy(bytes, 8);
  return bytes;
};

const segmentCommand = (vmaddr: bigint): Buffer => {
  const bytes = Buffer.alloc(72);
  bytes.writeUInt32LE(0x19, 0);
  bytes.writeUInt32LE(72, 4);
  bytes.write("__TEXT\0", 8, "latin1");
  bytes.writeBigUInt64LE(vmaddr, 24);
  bytes.writeBigUInt64LE(0x4000n, 32);
  return bytes;
};

/** One little-endian 64-bit slice with an LC_UUID and an optional __TEXT. */
const machoSlice = (spec: SliceSpec): Buffer => {
  const commands = [
    ...(spec.uuid === null ? [] : [uuidCommand(spec.uuid)]),
    ...(spec.withText === false ? [] : [segmentCommand(spec.textVmaddr)]),
  ];
  const body = commandBytes(commands);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(spec.cpu.type, 4);
  header.writeUInt32LE(spec.cpu.subtype, 8);
  header.writeUInt32LE(2, 12);
  header.writeUInt32LE(commands.length, 16);
  header.writeUInt32LE(body.length, 20);
  return Buffer.concat([header, body]);
};

/** A FAT container wrapping the given slices at 0x1000-byte alignment. */
const fatImage = (slices: readonly SliceSpec[]): Buffer => {
  const alignment = 0x1000;
  const table = Buffer.alloc(8 + slices.length * 20);
  table.writeUInt32BE(0xcafebabe, 0);
  table.writeUInt32BE(slices.length, 4);
  const bodies = slices.map(machoSlice);
  const offsets: number[] = [];
  let cursor = Math.ceil(table.length / alignment) * alignment;
  for (const [index, body_] of bodies.entries()) {
    offsets.push(cursor);
    table.writeUInt32BE(slices[index]?.cpu.type ?? 0, 8 + index * 20);
    table.writeUInt32BE(slices[index]?.cpu.subtype ?? 0, 12 + index * 20);
    table.writeUInt32BE(cursor, 16 + index * 20);
    table.writeUInt32BE(body_.length, 20 + index * 20);
    table.writeUInt32BE(12, 24 + index * 20);
    cursor += Math.ceil(body_.length / alignment) * alignment;
  }
  const out = Buffer.alloc(cursor);
  table.copy(out, 0);
  for (const [index, body_] of bodies.entries())
    body_.copy(out, offsets[index] ?? 0);
  return out;
};

const inspectWithJoin = async (
  root: string,
  artifact: Buffer,
  ipsOptions: Parameters<typeof appleIpsBytes>[0] = {},
) => {
  const ipsPath = join(root, "report.ips");
  const joinPath = join(root, "fixture.bin");
  await writeFile(ipsPath, appleIpsBytes(ipsOptions));
  await writeFile(joinPath, artifact);
  const result = await createAppleIpsService().inspect({
    path: ipsPath,
    join_path: joinPath,
  });
  if (!result.ok) throw result.error;
  const output = result.value.normalized_result as unknown as {
    readonly join: {
      readonly status: string;
      readonly reason?: string;
      readonly image_matches: readonly {
        readonly image_index: number;
        readonly slice_index: number;
        readonly uuid: string;
        readonly text_vmaddr: { readonly decimal: string };
      }[];
      readonly frames: readonly {
        readonly thread_index: number;
        readonly frame_index: number;
        readonly status: string;
        readonly reason: string | null;
        readonly static_address: { readonly decimal: string } | null;
      }[];
      readonly limitations: readonly string[];
    };
  };
  if (output.join.status === "unreadable")
    throw new Error(`join unreadable: ${String(output.join.reason)}`);
  return output;
};

describe("Apple IPS Mach-O and dSYM join", () => {
  it("joins matching UUID and architecture and derives static addresses", async () => {
    const root = await createTestTempDirectory("rea-apple-ips-join-");
    const report = await inspectWithJoin(
      root,
      fatImage([
        { cpu: X86_64, uuid: OTHER_UUID, textVmaddr: 0n },
        { cpu: ARM64, uuid: FIXTURE_UUID, textVmaddr: 0x100000000n },
      ]),
    );
    expect(report.join.status).toBe("selected");
    expect(report.join.image_matches).toEqual([
      {
        image_index: 0,
        uuid: FIXTURE_UUID,
        recorded_arch: "arm64",
        slice_index: 1,
        slice_offset: expect.any(String),
        slice_arch: "arm64",
        text_vmaddr: { decimal: "4294967296", hex: "0x100000000" },
        runtime_base: { decimal: "4294967296", hex: "0x100000000" },
      },
    ]);
    const faulting = report.join.frames[0];
    expect(faulting).toEqual({
      thread_index: 0,
      frame_index: 0,
      status: "joined",
      reason: null,
      static_address: { decimal: "4294968120", hex: "0x100000338" },
    });
    expect(report.join.frames).toHaveLength(5);
    expect(report.join.frames.every(({ status }) => status === "joined")).toBe(
      true,
    );
  });

  it("rejects a UUID match whose architecture differs", async () => {
    const root = await createTestTempDirectory("rea-apple-ips-join-arch-");
    const report = await inspectWithJoin(
      root,
      machoSlice({ cpu: X86_64, uuid: FIXTURE_UUID, textVmaddr: 0x100000000n }),
    );
    expect(report.join.status).toBe("selected");
    expect(report.join.image_matches).toEqual([]);
    expect(report.join.frames[0]).toMatchObject({
      status: "unjoined",
      reason: expect.stringContaining("does not match x86_64"),
    });
    expect(report.join.limitations.join("\n")).toContain(
      "does not match x86_64",
    );
  });

  it("refuses to join a rebuilt binary with a different LC_UUID", async () => {
    const root = await createTestTempDirectory("rea-apple-ips-join-uuid-");
    const report = await inspectWithJoin(
      root,
      machoSlice({ cpu: ARM64, uuid: OTHER_UUID, textVmaddr: 0x100000000n }),
    );
    expect(report.join.image_matches).toEqual([]);
    expect(report.join.frames[0]).toMatchObject({
      status: "unjoined",
      reason: expect.stringContaining("no slice LC_UUID matches"),
    });
  });

  it("never joins an image whose recorded UUID is all zeroes", async () => {
    const root = await createTestTempDirectory("rea-apple-ips-join-zero-");
    const report = await inspectWithJoin(
      root,
      machoSlice({ cpu: ARM64, uuid: FIXTURE_UUID, textVmaddr: 0x100000000n }),
      { uuid: "00000000-0000-0000-0000-000000000000" },
    );
    expect(report.join.image_matches).toEqual([]);
    expect(
      report.join.frames.every(({ reason }) =>
        reason?.includes("UUID is unknown"),
      ),
    ).toBe(true);
  });

  it("reports an unreadable join artifact without dropping report facts", async () => {
    const root = await createTestTempDirectory("rea-apple-ips-join-bad-");
    const ipsPath = join(root, "report.ips");
    const joinPath = join(root, "fixture.bin");
    await writeFile(ipsPath, appleIpsBytes());
    await writeFile(joinPath, Buffer.alloc(64, 0x41));
    const result = await createAppleIpsService().inspect({
      path: ipsPath,
      join_path: joinPath,
    });
    if (!result.ok) throw result.error;
    const report = result.value.normalized_result as { readonly join: unknown };
    expect(report.join).toMatchObject({
      status: "unreadable",
      reason: expect.any(String),
    });
  });
});

it.each([
  "slice-extent",
  "command-extent",
  "cpu-disagreement",
  "duplicate-uuid",
] as const)(
  "does not borrow identity outside the admitted %s",
  async (mode) => {
    const root = await createTestTempDirectory("rea-ips-invalid-join-");
    let bytes = fatImage([
      { cpu: ARM64, uuid: FIXTURE_UUID, textVmaddr: 0x100000000n },
    ]);
    if (mode === "slice-extent") bytes.writeUInt32BE(28, 20);
    if (mode === "command-extent") bytes.writeUInt32LE(0, 0x1000 + 20);
    if (mode === "cpu-disagreement") bytes.writeUInt32BE(X86_64.type, 8);
    if (mode === "duplicate-uuid") {
      const slice = machoSlice({
        cpu: ARM64,
        uuid: FIXTURE_UUID,
        textVmaddr: 0x100000000n,
      });
      bytes = Buffer.concat([slice, uuidCommand(FIXTURE_UUID)]);
      bytes.writeUInt32LE(3, 16);
      bytes.writeUInt32LE(bytes.length - 32, 20);
    }
    const path = join(root, "report.ips");
    const joinPath = join(root, "join.bin");
    await writeFile(path, appleIpsBytes());
    await writeFile(joinPath, bytes);
    const result = await createAppleIpsService().inspect({
      path,
      join_path: joinPath,
    });
    if (!result.ok) throw result.error;
    const report = appleIpsSchema.parse(result.value.normalized_result);
    expect(report.join).toMatchObject({
      status: "unreadable",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(report.images.length).toBeGreaterThan(0);
  },
);

it("retains completed report facts on a failed join read and charges join integer expansion", async () => {
  const root = await createTestTempDirectory("rea-ips-join-failure-");
  const path = join(root, "report.ips");
  const joinPath = join(root, "join.bin");
  await writeFile(path, appleIpsBytes());
  const service = createAppleIpsService();
  try {
    const plain = await service.inspect({ path });
    if (!plain.ok) throw plain.error;
    const report = appleIpsSchema.parse(plain.value.normalized_result);
    const missing = await service.inspect({ path, join_path: joinPath });
    expect(missing).toMatchObject({ ok: false });
    if (missing.ok) throw new Error("Missing join was admitted");
    expect(missing.error.partialObservation).toEqual(report);
    await writeFile(
      joinPath,
      machoSlice({ cpu: ARM64, uuid: FIXTURE_UUID, textVmaddr: 0x100000000n }),
    );
    const allowance = appleIpsReportIntegerTextBytes(report) + 128;
    const baseline = await service.inspect({
      path,
      max_integer_text_bytes: allowance,
    });
    expect(baseline.ok).toBe(true);
    const limited = await service.inspect({
      path,
      join_path: joinPath,
      max_integer_text_bytes: allowance,
    });
    expect(limited).toMatchObject({ ok: false });
    if (limited.ok) throw new Error("Join expansion exceeded its allowance");
    expect(limited.error.partialObservation).toEqual(report);
    const complete = await service.inspect({ path, join_path: joinPath });
    if (!complete.ok) throw complete.error;
    const joined = appleIpsSchema.parse(complete.value.normalized_result);
    expect(appleIpsReportIntegerTextBytes(joined)).toBeGreaterThan(allowance);
  } finally {
    await service.close();
  }
});

it("keeps a frame without imageOffset unjoined", async () => {
  const root = await createTestTempDirectory("rea-ips-unknown-offset-");
  const path = join(root, "report.ips");
  const joinPath = join(root, "join.bin");
  await writeFile(
    path,
    appleIpsBytes()
      .toString()
      .replace(/"imageOffset"\s*:\s*\d+/u, '"imageOffset":null'),
  );
  await writeFile(
    joinPath,
    machoSlice({ cpu: ARM64, uuid: FIXTURE_UUID, textVmaddr: 0x100000000n }),
  );
  const result = await createAppleIpsService().inspect({
    path,
    join_path: joinPath,
  });
  if (!result.ok) throw result.error;
  const joinResult = appleIpsSchema.parse(result.value.normalized_result).join;
  if (joinResult?.status !== "selected")
    throw new Error("Expected selected join");
  expect(joinResult.frames[0]).toMatchObject({
    status: "unjoined",
    static_address: null,
  });
});

it("uses the selected join budget even when report and join paths are identical", async () => {
  const root = await createTestTempDirectory("rea-ips-same-path-");
  const path = join(root, "report.ips");
  await writeFile(path, appleIpsBytes());
  const service = createAppleIpsService();
  try {
    const result = await service.inspect({
      path,
      join_path: path,
      max_join_bytes: 2,
    });
    if (result.ok) throw new Error("The join exceeded its own read allowance");
    const failure = projectAnalysisError(result.error);
    expect(failure).toMatchObject({
      code: "resource_constraint",
      details: {
        partial_observation: { artifact: { path } },
        reported_limits: { max_join_bytes: 2, selected_input: "join_path" },
      },
    });
    expect(JSON.stringify(failure)).toContain("max_join_bytes");
    expect(JSON.stringify(failure)).not.toContain("Raise max_file_bytes");
  } finally {
    await service.close();
  }
});
