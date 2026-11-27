import { expect, it, onTestFinished } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync, zstdCompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { encode } from "@msgpack/msgpack";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { runWithAnalysisOperationSnapshot } from "../../../src/domain/analysisOperationSnapshot.js";
import {
  MAXIMUM_ZSTD_MAX_FRAMES,
  MINIMUM_ZSTD_MAX_FRAMES,
} from "../../../src/domain/analysisResourceLimits.js";
import { pe } from "../../../src/domain/binaryTarget.fixture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  gpuCodeObjectsPartialSchema,
  gpuCodeObjectsSchema,
  inspectGpuCodeObjectsInputSchema,
  type GpuCodeObjectsInput,
} from "../../../src/domain/gpu/gpuCodeObjects.js";
import { GpuCodeObjectsProvider } from "../../../src/gpu/GpuCodeObjectsProvider.js";
import { GpuInventory } from "../../../src/gpu/GpuInventory.js";
import { nextGpuContainerOffset } from "../../../src/gpu/GpuSource.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  cudaFixture,
  cubinFixture,
  ccobFixture,
  hipFixture,
  peGpuFixture,
  elfFixture,
  ptxFixture,
  amdAbiFixture,
  amdDescriptorNoteFixture,
  amdFixture,
  amdNoteFixture,
  amdPalMetadataFixture,
  llvmBitcodeFixture,
  msgpackWithIntegerKeys,
} from "../../fixtures/gpu/codeObjects.js";
const inspect = async (
  bytes: Buffer,
  options: Partial<Omit<GpuCodeObjectsInput, "path">> = {},
) => {
  const root = await createTestTempDirectory("rea-gpu-"),
    path = join(root, "no-format-extension");
  await writeFile(path, bytes);
  const provider = new GpuCodeObjectsProvider();
  onTestFinished(() => provider.close());
  return provider.inspect({ path, analysis: "kernels", ...options });
};
it("reports a Zstandard frame-count refusal as an adjustable GPU limit", async () => {
  const frame = (byte: number) =>
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x01, 0x09, 0x00, 0x00, byte]);
  const compressed = Buffer.concat([frame(0x61), frame(0x62)]);
  const entry = Buffer.alloc(64 + Math.ceil(compressed.length / 8) * 8);
  entry.writeUInt16LE(1, 0);
  entry.writeUInt16LE(0x101, 2);
  entry.writeUInt32LE(64, 4);
  entry.writeBigUInt64LE(BigInt(entry.length - 64), 8);
  entry.writeUInt32LE(compressed.length, 16);
  entry.writeUInt32LE(80, 28);
  entry.writeBigUInt64LE(0x11n | 0x8000n, 40);
  entry.writeBigUInt64LE(2n, 56);
  compressed.copy(entry, 64);
  const header = Buffer.alloc(16);
  header.writeUInt32LE(0xba55ed50);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(16, 6);
  header.writeBigUInt64LE(BigInt(entry.length), 8);
  const result = await runWithAnalysisOperationSnapshot(
    { revision: 1, overrides: { "zstd.max_frames": 1 } },
    () => inspect(Buffer.concat([header, entry])),
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatchObject({
    _tag: "AnalysisResourceConstraintError",
    resource: "cpu",
    limit: {
      setting: "zstd.max_frames",
      effective_value: 1,
      source: "runtime",
      minimum: MINIMUM_ZSTD_MAX_FRAMES,
      maximum: MAXIMUM_ZSTD_MAX_FRAMES,
      unit: "count",
    },
  });
});

it.each(["none", "zstd", "lz4"] as const)(
  "reads selected CUDA metadata and PTX with %s compression",
  async (compression) => {
    const result = await inspect(cudaFixture(compression));
    if (!result.ok) throw result.error;
    expect(result.value.coverage).toMatchObject({
      discovery: "complete",
      payloads: "complete",
    });
    expect(
      result.value.kernels.map((row) => [
        row.name,
        row.parameter_count,
        row.parameter_bytes,
        row.shared_bytes,
        row.registers.physical,
      ]),
    ).toEqual([
      ["add_one", 2, 12, 32, null],
      ["add_one", 2, 12, 1056, 10],
    ]);
    expect(result.value.ptx_artifacts[0]!.text).toBe(ptxFixture);
    expect(
      result.value.kernels[1]!.parameters.map((row) => [
        row.ordinal,
        row.offset,
        row.size,
      ]),
    ).toEqual([
      [0, 0, 8],
      [1, 8, 4],
    ]);
  },
);

it("keeps each kernel resource location in its own payload", async () => {
  const inspected = await inspect(cudaFixture("none"));
  if (!inspected.ok) throw inspected.error;
  const report = inspected.value;
  const kernelIndex = report.kernels.findIndex(
    ({ representation }) => representation === "cuda-elf-metadata",
  );
  const kernel = report.kernels[kernelIndex];
  const sibling = report.objects.find(({ kind }) => kind === "ptx");
  if (
    !kernel?.sources.parameters ||
    sibling === undefined ||
    sibling.decoded_size === null ||
    sibling.decoded_size < 1
  )
    throw new Error(
      "Fixture needs a CUBIN parameter site and a decoded PTX sibling",
    );
  expect(kernel.sources.parameters.container_id).toBe(kernel.object_id);
  for (const container_id of [null, sibling.id]) {
    const replacement = {
      container_id,
      offset: 0,
      size: 1,
      section_index: null,
      section_name: null,
    };
    const kernels = report.kernels.with(kernelIndex, {
      ...kernel,
      sources: { ...kernel.sources, parameters: replacement },
    });
    expect(
      gpuCodeObjectsSchema.safeParse({ ...report, kernels }),
    ).toMatchObject({
      success: false,
      error: {
        issues: [
          expect.objectContaining({
            path: ["kernels", kernelIndex, "sources", "parameters"],
          }),
        ],
      },
    });
  }
});

it("observes cancellation during a cubin kernel directory read", async () => {
  const cubin = cubinFixture();
  const section = Number(cubin.readBigUInt64LE(40)) + 64;
  const offset = Number(cubin.readBigUInt64LE(section + 24));
  const size = Number(cubin.readBigUInt64LE(section + 32));
  const names = cubin.subarray(offset, offset + size);
  const compressionHeader = Buffer.alloc(24);
  compressionHeader.writeUInt32LE(2);
  compressionHeader.writeBigUInt64LE(BigInt(names.length), 8);
  compressionHeader.writeBigUInt64LE(1n, 16);
  const encodedNames = Buffer.concat([
    compressionHeader,
    zstdCompressSync(names),
  ]);
  const bytes = Buffer.concat([cubin, encodedNames]);
  bytes.writeBigUInt64LE(0x800n, section + 8);
  bytes.writeBigUInt64LE(BigInt(cubin.length), section + 24);
  bytes.writeBigUInt64LE(BigInt(encodedNames.length), section + 32);

  const controller = new AbortController();
  const inventory = new GpuInventory(
    { path: "/artifacts/cubin", analysis: "kernels" },
    controller.signal,
  );
  const cancelled = new Error("kernel directory read cancelled");
  let payloadReads = 0;
  let pendingAbort: NodeJS.Immediate | undefined;
  try {
    await expect(
      inventory.inspect({
        size: bytes.length,
        containerId: null,
        read: async (at, count) => {
          // The selected payload is re-read into the kernel parser's buffer.
          if (at === 0 && count === bytes.length && ++payloadReads === 1)
            pendingAbort = setImmediate(() => controller.abort(cancelled));
          return bytes.subarray(at, at + count);
        },
      }),
    ).rejects.toMatchObject({ reason: "cancelled", cause: cancelled });
    expect(payloadReads).toBe(1);
  } finally {
    if (pendingAbort !== undefined) clearImmediate(pendingAbort);
  }
});
it("decodes a CUDA 0x2000 LZ4 entry to the exact declared payload", async () => {
  const ptx = Buffer.from(ptxFixture),
    bytes = cudaFixture("lz4", [{ kind: 1, target: 80, bytes: ptx }]),
    // The first fatbinary header is 16 bytes, so the first entry starts there.
    entry = 16;
  // The fixture must really encode: a stored-profile fallback would leave the
  // LZ4 selection path unexercised while this control still passed.
  expect(bytes.readBigUInt64LE(entry + 40)).toBe(0x2011n);
  const result = await inspect(bytes);
  if (!result.ok) throw result.error;
  expect(result.value.objects[0]).toMatchObject({
    kind: "ptx",
    compression: "lz4",
    compression_id: "cuda-flags:0x2011",
    decoded_size: ptx.length,
    inspection: "complete",
    sha256: createHash("sha256").update(ptx).digest("hex"),
  });
  expect(result.value.coverage.payloads).toBe("complete");
  expect(result.value.ptx_artifacts.map((row) => row.text)).toEqual([
    ptxFixture,
  ]);
});
it("rejects a CUDA LZ4 entry whose declared decoded length disagrees", async () => {
  const bytes = cudaFixture("lz4", [
      { kind: 1, target: 80, bytes: Buffer.from(ptxFixture) },
    ]),
    entry = 16;
  // Grow only the declared output length; the encoded literals cannot reach it.
  bytes.writeBigUInt64LE(
    BigInt(Buffer.byteLength(ptxFixture) + 16),
    entry + 56,
  );
  const result = await inspect(bytes);
  if (!result.ok) throw result.error;
  expect(result.value.objects[0]).toMatchObject({
    compression: "lz4",
    inspection: "malformed",
    sha256: null,
  });
  expect(result.value.coverage.payloads).toBe("partial");
  expect(result.value.ptx_artifacts).toEqual([]);
});
it("preserves CUDA inventory and selection across an oversized declared decoded length", async () => {
  const bytes = cudaFixture("zstd", [
    { kind: 2, target: 90, bytes: cubinFixture({ architecture: 90 }) },
    { kind: 1, target: 80, bytes: Buffer.from(ptxFixture) },
  ]);
  const firstEntry = 16;
  const declared = 1n << 53n;
  const encoded = bytes.readUInt32LE(firstEntry + 16);
  bytes.writeBigUInt64LE(declared, firstEntry + 56);
  const inventory = await inspect(bytes, { analysis: "inventory" });
  if (!inventory.ok) throw inventory.error;
  expect(inventory.value.artifact).toMatchObject({
    path: expect.stringContaining("no-format-extension"),
    file_size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  expect(inventory.value.objects).toMatchObject([
    {
      target: "sm_90",
      inspection: "inventory",
      encoded_size: encoded,
      decoded_size: null,
      location: { offset: firstEntry + 64, size: encoded },
      limitations: [expect.stringContaining(String(declared))],
    },
    { target: "sm_80", inspection: "inventory" },
  ]);
  for (const [targets, inspection] of [
    [undefined, "capacity"],
    [["sm_80"], "not-selected"],
  ] as const) {
    const result = await inspect(
      bytes,
      targets ? { targets: [...targets] } : {},
    );
    if (!result.ok) throw result.error;
    expect(result.value.objects).toMatchObject([
      { id: inventory.value.objects[0]!.id, target: "sm_90", inspection },
      {
        id: inventory.value.objects[1]!.id,
        target: "sm_80",
        inspection: "complete",
      },
    ]);
    expect(result.value.kernels.map(({ name }) => name)).toEqual(["add_one"]);
  }
});
it("retains the unsupported legacy CUDA compression declaration and extents", async () => {
  const result = await inspect(
    cudaFixture("legacy", [
      { kind: 1, target: 80, bytes: Buffer.from(ptxFixture), flags: 4 },
    ]),
  );
  if (!result.ok) throw result.error;
  expect(result.value.objects[0]).toMatchObject({
    compression: "unsupported",
    compression_id: expect.stringContaining("cuda-flags:0x1015"),
    encoded_size: deflateSync(Buffer.from(ptxFixture)).length,
    decoded_size: Buffer.byteLength(ptxFixture),
    inspection: "unsupported",
  });
  expect(result.value.ptx_artifacts).toEqual([]);
  expect(result.value.kernels).toEqual([]);
  expect(result.value.objects[0]!.limitations.join(" ")).toContain(
    "compression/version is not supported",
  );
});
it.each([1, 2, 3] as const)(
  "reads CCOB v%d zlib/Zstd and retains exact decoded provenance",
  async (version) => {
    for (const method of ["zlib", "zstd"] as const) {
      const result = await inspect(ccobFixture(version, method));
      if (!result.ok) throw result.error;
      expect(result.value.kernels[0]).toMatchObject({
        name: "add_one",
        parameter_count: 2,
        parameter_bytes: 12,
        registers: { sgpr: 6, vgpr: 2 },
        shared_bytes: 0,
      });
      expect(result.value.objects[2]!.location.container_id).toBe(
        result.value.objects[0]!.id,
      );
    }
  },
);
it("does not decode unselected payloads and keeps stable positional identities", async () => {
  const bytes = cudaFixture("zstd");
  const inventory = await inspect(bytes, { analysis: "inventory" }),
    selected = await inspect(bytes, { targets: ["sm_90"] });
  if (!inventory.ok) throw inventory.error;
  if (!selected.ok) throw selected.error;
  expect(inventory.value.kernels).toEqual([]);
  expect(selected.value.objects.map((row) => row.id)).toEqual(
    inventory.value.objects.map((row) => row.id),
  );
  expect(selected.value.ptx_artifacts).toEqual([]);
  expect(selected.value.kernels).toHaveLength(1);
  expect(selected.value.coverage.payloads).toBe("partial");
});
it.each(["cubin", "ptx"] as const)(
  "retains conflicting container and %s target declarations as partial facts",
  async (kind) => {
    const bytes = cudaFixture("none", [
      {
        kind: kind === "cubin" ? 2 : 1,
        target: 80,
        bytes:
          kind === "cubin"
            ? cubinFixture({ architecture: 90 })
            : Buffer.from(ptxFixture.replace("sm_80", "sm_90")),
      },
    ]);
    const result = await inspect(bytes, { targets: ["sm_80"] });
    if (!result.ok) throw result.error;
    expect(result.value.objects[0]).toMatchObject({
      target: "sm_80",
      payload_target: "sm_90",
      target_consistency: "conflict",
      inspection: "partial",
    });
    expect(result.value.coverage.payloads).toBe("partial");
    expect(result.value.kernels).toHaveLength(1);
    expect(result.value.kernels[0]!.limitations.join(" ")).toContain(
      "inventory sm_80; payload sm_90",
    );
    const unexamined = await inspect(bytes, { targets: ["sm_90"] });
    if (!unexamined.ok) throw unexamined.error;
    expect(unexamined.value.objects[0]).toMatchObject({
      target: "sm_80",
      payload_target: null,
      target_consistency: "unexamined",
      inspection: "not-selected",
    });
    expect(unexamined.value.coverage.payloads).toBe("partial");
  },
);
it("keeps CUBIN base-only agreement distinct from verified feature-profile agreement", async () => {
  const bytes = cudaFixture("none", [
    { kind: 2, target: 90, bytes: cubinFixture({ architecture: 90 }) },
  ]);
  bytes.writeBigUInt64LE(bytes.readBigUInt64LE(16 + 40) | 0x100000n, 16 + 40);
  const result = await inspect(bytes, { targets: ["sm_90a"] });
  if (!result.ok) throw result.error;
  expect(result.value.objects[0]).toMatchObject({
    target: "sm_90a",
    payload_target: "sm_90",
    target_consistency: "base-only",
    inspection: "complete",
  });
});
it.each([
  [100, 0x06006402],
  [101, 0x06006502],
  [103, 0x05006702],
  [120, 0x06007802],
  [121, 0x06007902],
])(
  "reads ABI-qualified CUDA target sm_%d from released NVIDIA header flags",
  async (architecture, flags) => {
    const result = await inspect(cubinFixture({ osAbi: 0x41, flags }));
    if (!result.ok) throw result.error;
    expect(result.value.objects[0]).toMatchObject({
      target: `sm_${architecture}`,
      payload_target: `sm_${architecture}`,
      target_consistency: "single-source",
      inspection: "complete",
      cuda_target_header: {
        os_abi: 0x41,
        flags: `0x${flags.toString(16).padStart(8, "0")}`,
      },
    });
  },
);
it("keeps unsupported CUDA flag layouts unknown while retaining raw header evidence", async () => {
  const result = await inspect(
    cubinFixture({ osAbi: 0x41, flags: 0x06016402 }),
  );
  if (!result.ok) throw result.error;
  expect(result.value.objects[0]).toMatchObject({
    target: null,
    payload_target: null,
    target_consistency: "unknown",
    inspection: "partial",
    cuda_target_header: { os_abi: 0x41, flags: "0x06016402" },
  });
  expect(result.value.kernels).toHaveLength(1);
  expect(result.value.kernels[0]!.limitations.join(" ")).toContain(
    "target encoding is unknown",
  );
  const inventory = await inspect(
    cubinFixture({ osAbi: 0x41, flags: 0x06016402 }),
    { analysis: "inventory" },
  );
  if (!inventory.ok) throw inventory.error;
  expect(inventory.value.coverage.discovery).toBe("partial");
});
it("discovers standalone AMD targets before exact selection", async () => {
  const bytes = amdFixture(),
    target = "amdgcn-amd-amdhsa--gfx900";
  const inventory = await inspect(bytes, { analysis: "inventory" });
  const selected = await inspect(bytes, { targets: [target] });
  const skipped = await inspect(bytes, {
    targets: ["amdgcn-amd-amdhsa--gfx1100"],
  });
  if (!inventory.ok) throw inventory.error;
  if (!selected.ok) throw selected.error;
  if (!skipped.ok) throw skipped.error;
  expect(inventory.value.objects[0]).toMatchObject({
    target,
    inspection: "inventory",
    sha256: null,
  });
  expect(inventory.value.kernels).toEqual([]);
  expect(selected.value.objects[0]).toMatchObject({
    target,
    inspection: "complete",
    id: inventory.value.objects[0]!.id,
  });
  expect(selected.value.kernels).toHaveLength(1);
  expect(selected.value.kernels[0]).toMatchObject({
    representation: "amdgpu-metadata",
    parameter_bytes: 12,
  });
  expect(skipped.value.objects[0]).toMatchObject({
    target,
    inspection: "not-selected",
    sha256: null,
  });
  expect(skipped.value.kernels).toEqual([]);
  expect(skipped.value.coverage.payloads).toBe("partial");
});
it("derives V3 AMDGPU processor identity from ELF flags when the note omits it", async () => {
  const bytes = amdFixture(false, undefined, null);
  // EF_AMDGPU_MACH=0x2c identifies gfx900; high bits include feature flags.
  bytes.writeUInt32LE(0x12c, 48);
  const inventory = await inspect(bytes, { analysis: "inventory" });
  if (!inventory.ok) throw inventory.error;
  expect(inventory.value.objects[0]).toMatchObject({
    target: "gfx900",
    target_consistency: "single-source",
    inspection: "inventory",
  });
  const selected = await inspect(bytes, { targets: ["gfx900"] });
  if (!selected.ok) throw selected.error;
  expect(selected.value.objects[0]).toMatchObject({
    payload_target: "gfx900",
    amd_pal_metadata: null,
    amd_target_metadata: {
      os_abi: 64,
      abi: "amdhsa",
      note_coverage: "complete",
      notes: [{ target: null, target_state: "absent" }],
    },
  });
  expect(selected.value.kernels).toHaveLength(1);
  expect(selected.value.kernels[0]).toMatchObject({ parameter_bytes: 12 });
});
it("distinguishes an invalid MessagePack target from legacy note coverage", async () => {
  const legacy = Buffer.alloc(20);
  legacy.writeUInt32LE(4, 0);
  legacy.writeUInt32LE(4, 4);
  legacy.writeUInt32LE(10, 8); // YAML rather than MessagePack
  legacy.write("AMD\0", 12);
  const declared = "amdgcn-amd-amdhsa--gfx900";
  for (const [bytes, target, state, limitation] of [
    [
      amdFixture(false, undefined, 123),
      null,
      "invalid",
      /target is not a string/u,
    ],
    [amdFixture(false, legacy), declared, "declared", /Legacy AMDGPU YAML/u],
  ] as const) {
    const result = await inspect(bytes);
    if (!result.ok) throw result.error;
    const row = result.value.objects[0]!;
    expect(row).toMatchObject({
      target,
      payload_target: target,
      amd_target_metadata: {
        note_coverage: "partial",
        notes: [{ target, target_state: state }],
      },
    });
    expect(row.limitations.join(" ")).toMatch(limitation);
    expect(result.value.coverage.payloads).toBe("partial");
    expect(result.value.kernels.map(({ name }) => name)).toEqual(["add_one"]);
  }
});
it("keeps AMDGPU processor identity unknown when ELF flags are unassigned", async () => {
  const bytes = amdFixture(false, undefined, null);
  bytes.writeUInt32LE(0x17f, 48);
  const result = await inspect(bytes, { analysis: "inventory" });
  if (!result.ok) throw result.error;
  expect(result.value.objects[0]).toMatchObject({
    target: null,
    target_consistency: "unknown",
    inspection: "inventory",
  });
});
const palNote = (bytes: Buffer, metadata: Buffer) => ({
  container_id: "file@0",
  section_index: 2,
  section_name: ".note",
  offset: bytes.indexOf(metadata),
  size: metadata.length,
});
it("reports PAL-ABI target, ABI and declared pipeline facts without HSA kernels", async () => {
  const metadata = amdPalMetadataFixture();
  const bytes = amdAbiFixture(65, metadata);
  const inventory = await inspect(bytes, { analysis: "inventory" });
  if (!inventory.ok) throw inventory.error;
  const header = {
    processor: "gfx1030",
    os_abi: 65,
    abi: "amdpal",
    note_coverage: "complete",
    notes: [
      {
        target: null,
        target_state: "absent",
        location: palNote(bytes, metadata),
      },
    ],
  };
  expect(inventory.value.objects[0]).toMatchObject({
    target: "gfx1030",
    inspection: "inventory",
    amd_target_metadata: header,
    amd_pal_metadata: null,
    limitations: [],
  });
  expect(inventory.value.coverage.discovery).toBe("complete");
  const selected = await inspect(bytes, { targets: ["gfx1030"] });
  if (!selected.ok) throw selected.error;
  expect(selected.value.objects[0]).toMatchObject({
    target: "gfx1030",
    inspection: "complete",
    amd_target_metadata: header,
    limitations: [],
  });
  expect(selected.value.objects[0]!.amd_pal_metadata).toEqual({
    version: { major: 3, minor: 0 },
    pipelines: [
      {
        index: 0,
        name: "triangle",
        type: "VsPs",
        api: "Vulkan",
        shaders: [
          { stage: ".vertex", hardware_mapping: [".vs"] },
          { stage: ".pixel", hardware_mapping: [".ps"] },
        ],
        hardware_stages: [
          {
            stage: ".vs",
            entry_point: "_amdgpu_vs_main",
            entry_point_symbol: "main_vs",
            sgpr_count: 20,
            vgpr_count: 12,
            agpr_count: null,
            wavefront_size: 32,
            lds_size: null,
            scratch_memory_size: 0,
          },
          {
            stage: ".ps",
            entry_point: "_amdgpu_ps_main",
            entry_point_symbol: null,
            sgpr_count: 10,
            vgpr_count: 6,
            agpr_count: null,
            wavefront_size: null,
            lds_size: 256,
            scratch_memory_size: null,
          },
        ],
        location: palNote(bytes, metadata),
      },
    ],
  });
  expect(selected.value.kernels).toEqual([]);
  expect(selected.value.coverage.payloads).toBe("complete");
  expect(gpuCodeObjectsSchema.safeParse(selected.value).success).toBe(true);
});
it("keeps a PAL-ABI object without metadata unsupported with its target", async () => {
  for (const analysis of ["inventory", "kernels"] as const) {
    const result = await inspect(amdAbiFixture(65, null), { analysis });
    if (!result.ok) throw result.error;
    expect(result.value.objects[0]).toMatchObject({
      target: "gfx1030",
      inspection: "unsupported",
      amd_target_metadata: { os_abi: 65, abi: "amdpal", notes: [] },
      amd_pal_metadata: null,
      limitations: [
        "No AMDGPU PAL MessagePack pipeline metadata was available",
      ],
    });
  }
});
it("keeps the version of an LLVM PAL note that omits amdpal.version null", async () => {
  // llc 23 -mtriple=amdgcn--amdpal emits only amdpal.pipelines.
  const metadata = msgpackWithIntegerKeys({
    "amdpal.pipelines": [
      {
        ".hardware_stages": {
          ".ps": { ".entry_point_symbol": "ps_main", ".sgpr_count": 1 },
        },
        ".registers": new Map([[0x2c0a, 0x22f0000]]),
      },
    ],
  });
  const result = await inspect(amdAbiFixture(65, metadata));
  if (!result.ok) throw result.error;
  expect(result.value.objects[0]).toMatchObject({
    inspection: "complete",
    limitations: [],
    amd_pal_metadata: {
      version: null,
      pipelines: [{ hardware_stages: [{ stage: ".ps", sgpr_count: 1 }] }],
    },
  });
});
it("keeps an unexpected PAL scalar unknown and coverage partial", async () => {
  const metadata = Buffer.from(
    encode({
      "amdpal.version": [3, 0],
      "amdpal.pipelines": [
        { ".hardware_stages": { ".cs": { ".sgpr_count": "many" } } },
      ],
    }),
  );
  const result = await inspect(amdAbiFixture(65, metadata));
  if (!result.ok) throw result.error;
  const row = result.value.objects[0]!;
  expect(row.inspection).toBe("partial");
  expect(row.amd_pal_metadata?.pipelines[0]?.hardware_stages).toMatchObject([
    { stage: ".cs", sgpr_count: null },
  ]);
  expect(row.limitations).toEqual([
    "AMDGPU PAL note 0 pipeline 0 stage .cs .sgpr_count is not an unsigned integer; it remains unknown",
  ]);
});
it.each([
  ["truncated MessagePack", () => amdPalMetadataFixture().subarray(0, 40)],
  [
    // A MessagePack binary value is not a map, even when empty.
    "a binary pipeline entry",
    () =>
      Buffer.from(
        encode({
          "amdpal.version": [3, 0],
          "amdpal.pipelines": [
            { ".type": "Cs", ".hardware_stages": {} },
            new Uint8Array(0),
          ],
        }),
      ),
  ],
  [
    "a non-map hardware stage table",
    () =>
      Buffer.from(
        encode({
          "amdpal.version": [3, 0],
          "amdpal.pipelines": [
            { ".type": "Cs", ".hardware_stages": {} },
            { ".type": "Cs", ".hardware_stages": [".cs"] },
          ],
        }),
      ),
  ],
])("reports a PAL note with %s as malformed", async (label, metadata) => {
  for (const analysis of ["inventory", "kernels"] as const) {
    const result = await inspect(amdAbiFixture(65, metadata()), { analysis });
    if (!result.ok) throw result.error;
    expect(result.value.objects[0]).toMatchObject({
      target: "gfx1030",
      inspection: "malformed",
      amd_target_metadata: { abi: "amdpal" },
    });
  }
  const retained = await inspect(amdAbiFixture(65, metadata()));
  if (!retained.ok) throw retained.error;
  // Pipelines decoded before the failure stay as declared facts.
  expect(
    retained.value.objects[0]!.amd_pal_metadata?.pipelines.map(
      ({ index, type }) => ({ index, type }),
    ) ?? [],
  ).toEqual(
    label === "truncated MessagePack" ? [] : [{ index: 0, type: "Cs" }],
  );
});
it("shares one decoded-value allowance across a code object's PAL notes", async () => {
  // Each note fits the per-note allowance; together they exceed it.
  const note = amdDescriptorNoteFixture(
    Buffer.from(
      encode({ "amdpal.pipelines": Array.from({ length: 65536 }, () => ({})) }),
    ),
  );
  const bytes = elfFixture(224, [
    {
      name: ".note",
      type: 7,
      bytes: Buffer.concat([note, note, note, note, note]),
    },
  ]);
  bytes[7] = 65;
  // Inventory decodes every note, so the allowance applies before selection.
  const result = await inspect(bytes, { analysis: "inventory" });
  if (!result.ok) throw result.error;
  const row = result.value.objects[0]!;
  expect(row).toMatchObject({ inspection: "capacity", amd_pal_metadata: null });
  expect(row.limitations.join(" ")).toContain("262144-value");
});
it.each([
  [66, "mesa3d", /Mesa3D-ABI metadata is outside/u],
  [0, "unknown", /OS ABI 0 is not a recognized AMDGPU runtime ABI/u],
] as const)(
  "never reads OS ABI %s notes under the HSA schema",
  async (osAbi, abi, limitation) => {
    // An HSA-shaped note under another ABI must not yield HSA kernels.
    const note = amdNoteFixture();
    const result = await inspect(
      amdAbiFixture(osAbi, note.subarray(20, 20 + note.readUInt32LE(4))),
    );
    if (!result.ok) throw result.error;
    const row = result.value.objects[0]!;
    expect(row).toMatchObject({
      target: "gfx1030",
      inspection: "unsupported",
      amd_target_metadata: {
        os_abi: osAbi,
        abi,
        note_coverage: "partial",
        notes: [],
      },
      amd_pal_metadata: null,
    });
    expect(row.limitations.join(" ")).toMatch(limitation);
    expect(result.value.kernels).toEqual([]);
  },
);
it.each([false, true])(
  "keeps HIP bitcode representation unsupported with wrapped=%s and no declared processor",
  async (wrapped) => {
    const payload = llvmBitcodeFixture(wrapped),
      bytes = hipFixture(payload, "hip-amdgcn-amd-amdhsa--");
    for (const analysis of ["inventory", "kernels"] as const) {
      const result = await inspect(bytes, { analysis });
      if (!result.ok) throw result.error;
      const row = result.value.objects.find(({ kind }) => kind === "amdgpu")!;
      expect(row).toMatchObject({
        bundle_id: "hip-amdgcn-amd-amdhsa--",
        target: null,
        payload_target: null,
        inspection: analysis === "inventory" ? "inventory" : "unsupported",
        encoded_size: payload.length,
        location: { size: payload.length },
        sha256:
          analysis === "inventory"
            ? null
            : createHash("sha256").update(payload).digest("hex"),
      });
      expect(row.limitations.join(" ")).toContain("LLVM bitcode");
      expect(row.limitations.join(" ")).not.toContain("not an ELF image");
      expect(result.value.coverage).toMatchObject({
        discovery: "partial",
        payloads: analysis === "inventory" ? "not-requested" : "partial",
      });
      expect(result.value.kernels).toEqual([]);
    }
  },
);
it.each([
  ["amdgcn", "gfx900:xnack+"],
  ["amdgcn", "gfx900+xnack"],
  ["amdgcn", "gfx900:sramecc-:xnack+"],
  ["amdgpu", "gfx900:xnack+"],
  ["amdgpu9", "gfx900:xnack+"],
  ["amdgpu9.00", "gfx900:sramecc-:xnack+"],
])(
  "preserves matching AMDGPU %s note features with ELF processor flags (%s)",
  async (triple, target) => {
    const noteTarget = `${triple}-amd-amdhsa--${target}`;
    const payload = amdFixture(false, undefined, noteTarget);
    payload.writeUInt32LE(0x12c, 48);
    const result = await inspect(
      hipFixture(payload, `hipv4-amdgcn-amd-amdhsa--${target}`),
      { targets: [target] },
    );
    if (!result.ok) throw result.error;
    expect(
      result.value.objects.find(({ kind }) => kind === "amdgpu"),
    ).toMatchObject({
      target,
      payload_target: noteTarget,
      target_consistency: "consistent",
      inspection: "complete",
    });
    expect(result.value.kernels).toHaveLength(1);
    expect(result.value.coverage.payloads).toBe("complete");
  },
);
it.each(["amdgcn", "amdgpu9.00"])(
  "does not choose between conflicting AMDGPU %s note and ELF processor identities",
  async (triple) => {
    const declared = `${triple}-amd-amdhsa--gfx900:xnack+`;
    const bytes = amdFixture(false, undefined, declared);
    bytes.writeUInt32LE(0x141, 48); // EF_AMDGPU_MACH gfx1100
    const result = await inspect(bytes);
    if (!result.ok) throw result.error;
    expect(result.value.objects[0]).toMatchObject({
      target: null,
      payload_target: null,
      target_consistency: "unknown",
      inspection: "partial",
      amd_target_metadata: {
        flags: "0x00000141",
        processor: "gfx1100",
        note_coverage: "complete",
        notes: [{ target: declared, target_state: "declared" }],
      },
    });
    expect(result.value.objects[0]!.limitations.join(" ")).toContain(
      "processor flags conflict with target note metadata",
    );
    expect(result.value.kernels).toHaveLength(1);
  },
);
it.each([
  "producer-specific-gpu-target",
  "amdgpu9.00-amd-amdhsa--gfx900:xnack",
])(
  "retains the unrecognized AMDGPU note target %s without substituting ELF processor flags",
  async (noteTarget) => {
    const result = await inspect(
      hipFixture(amdFixture(false, undefined, noteTarget)),
      { targets: ["gfx900"] },
    );
    if (!result.ok) throw result.error;
    const row = result.value.objects.find(({ kind }) => kind === "amdgpu");
    expect(row).toMatchObject({
      target: "gfx900",
      payload_target: noteTarget,
      target_consistency: "unknown",
      inspection: "complete",
    });
    expect(result.value.coverage.payloads).toBe("complete");
    expect(result.value.kernels).toMatchObject([
      { name: "add_one", parameter_bytes: 12, registers: { sgpr: 6, vgpr: 2 } },
    ]);
    expect(row?.limitations.join(" ")).not.toContain(
      "Conflicting target declarations",
    );
    expect(result.value.kernels[0]?.limitations.join(" ")).not.toContain(
      "Conflicting target declarations",
    );
  },
);
it("retains kernels from conflicting AMDGPU notes without choosing either note or ELF flags", async () => {
  const first = amdNoteFixture();
  const second = amdNoteFixture(false, "amdgcn-amd-amdhsa--gfx1100");
  const bytes = amdFixture(false, second);
  const firstDescriptor = bytes.indexOf(first) + 20;
  const result = await inspect(bytes);
  if (!result.ok) throw result.error;
  expect(result.value.objects).toMatchObject([
    {
      kind: "amdgpu",
      target: null,
      payload_target: null,
      target_consistency: "unknown",
      inspection: "partial",
      amd_target_metadata: {
        note_coverage: "complete",
        notes: [
          {
            target: "amdgcn-amd-amdhsa--gfx900",
            target_state: "declared",
            location: { offset: firstDescriptor, size: first.readUInt32LE(4) },
          },
          {
            target: "amdgcn-amd-amdhsa--gfx1100",
            target_state: "declared",
            location: {
              offset: firstDescriptor + first.length,
              size: second.readUInt32LE(4),
            },
          },
        ],
      },
    },
  ]);
  expect(result.value.objects[0]?.limitations).toContainEqual(
    expect.stringMatching(
      /conflicting processor targets.*identity is unknown/iu,
    ),
  );
  expect(result.value.coverage).toMatchObject({
    discovery: "partial",
    payloads: "partial",
  });
  expect(result.value.kernels).toMatchObject([
    { name: "add_one", parameter_bytes: 12, registers: { sgpr: 6, vgpr: 2 } },
    { name: "add_one", parameter_bytes: 12, registers: { sgpr: 6, vgpr: 2 } },
  ]);
  expect(new Set(result.value.kernels.map(({ id }) => id)).size).toBe(2);
  const selected = await inspect(bytes, { targets: ["gfx900"] });
  if (!selected.ok) throw selected.error;
  expect(selected.value.objects[0]).toMatchObject({
    target: null,
    payload_target: null,
    target_consistency: "unknown",
    inspection: "not-selected",
  });
  expect(selected.value.kernels).toEqual([]);
});
it.each(
  [
    "amdgcn-amd-amdhsa-unknown-",
    "amdgpu9.00-amd-amdhsa--",
    "amdgpu9.00-amd-amdhsa-unknown-",
  ].flatMap((prefix) =>
    (
      [
        ["gfx900", "gfx900", "consistent"],
        ["gfx1100", "gfx900", "conflict"],
        ["gfx900", "gfx900:xnack+", "unknown"],
        ["gfx900", "gfx900+xnack", "unknown"],
        ["gfx900+xnack", "gfx900", "unknown"],
        ["GFX900", "gfx900", "unknown"],
        ["gfx900", "GFX900", "unknown"],
      ] as const
    ).map(([inventoryTarget, payloadTargetId, consistency]) => ({
      inventoryTarget,
      payloadTarget: `${prefix}${payloadTargetId}`,
      consistency,
    })),
  ),
)(
  "compares AMDGPU inventory $inventoryTarget with note $payloadTarget as $consistency",
  async ({ inventoryTarget, payloadTarget, consistency }) => {
    const bytes = hipFixture(
      amdFixture(false, undefined, payloadTarget),
      `hipv4-amdgcn-amd-amdhsa--${inventoryTarget}`,
    );
    const result = await inspect(bytes, { targets: [inventoryTarget] });
    if (!result.ok) throw result.error;
    const row = result.value.objects.find((value) => value.kind === "amdgpu")!;
    expect(row.payload_target).toBe(payloadTarget);
    expect(result.value.kernels).toHaveLength(1);
    if (consistency === "conflict") {
      expect(row).toMatchObject({
        target: inventoryTarget,
        target_consistency: "conflict",
        inspection: "partial",
      });
      expect(result.value.coverage.payloads).toBe("partial");
      expect(result.value.kernels[0]!.limitations.join(" ")).toContain(
        "Conflicting target declarations",
      );
    } else {
      expect(row).toMatchObject({
        target: inventoryTarget,
        target_consistency: consistency,
        inspection: "complete",
      });
      expect(result.value.coverage.payloads).toBe("complete");
      expect(result.value.kernels[0]!.limitations.join(" ")).not.toContain(
        "Conflicting target declarations",
      );
    }
  },
);
it.each([
  "hipv4-amdgcn-amd-amdhsa--gfx900",
  "hipv4-amdgcn-amd-amdhsa-gfx900",
  "hipv4-amdgcn-amd-amdhsa-opaque",
  "hipv4-amdgpu9.00-amd-amdhsa--gfx900",
])("keeps discovered HIP targets selectable for %s", async (targetId) => {
  const bytes = hipFixture(amdFixture(), targetId);
  const inventory = await inspect(bytes, { analysis: "inventory" });
  if (!inventory.ok) throw inventory.error;
  const row = inventory.value.objects.find((value) => value.kind === "amdgpu")!;
  const expectedTarget = targetId.endsWith("opaque")
    ? "amdgcn-amd-amdhsa--gfx900"
    : "gfx900";
  expect(row.target).toBe(expectedTarget);
  const selected = await inspect(bytes, { targets: [expectedTarget] });
  if (!selected.ok) throw selected.error;
  expect(selected.value.kernels).toHaveLength(1);
  expect(
    selected.value.objects.find((value) => value.kind === "amdgpu"),
  ).toMatchObject({
    target: expectedTarget,
    payload_target: "amdgcn-amd-amdhsa--gfx900",
    target_consistency: targetId.endsWith("opaque")
      ? "single-source"
      : "consistent",
    inspection: "complete",
  });
});
it.each(["gfx11-generic", "gfx9-4-generic"] as const)(
  "preserves and exactly selects the generic AMDGPU processor %s",
  async (processor) => {
    const noteTarget = `amdgcn-amd-amdhsa--${processor}`;
    const payload = amdFixture(false, undefined, noteTarget);
    payload.writeUInt32LE(processor === "gfx11-generic" ? 0x54 : 0x5f, 48);
    const bytes = hipFixture(payload, `hipv4-amdgcn-amd-amdhsa--${processor}`);
    const result = await inspect(bytes, { targets: [processor] });
    if (!result.ok) throw result.error;
    expect(
      result.value.objects.find(({ kind }) => kind === "amdgpu"),
    ).toMatchObject({
      kind: "amdgpu",
      target: processor,
      payload_target: noteTarget,
      target_consistency: "consistent",
      inspection: "complete",
    });
    expect(result.value.kernels).toHaveLength(1);
  },
);
it("recognizes a modern AMDGPU triple inside compressed CCOB v3", async () => {
  const targetId = "hipv4-amdgpu9.00-amd-amdhsa--gfx900";
  const bytes = ccobFixture(3, "zstd", hipFixture(amdFixture(), targetId));
  const result = await inspect(bytes);
  if (!result.ok) throw result.error;
  expect(
    result.value.objects.find(({ bundle_id }) => bundle_id === targetId),
  ).toMatchObject({
    kind: "amdgpu",
    target: "gfx900",
    payload_target: "amdgcn-amd-amdhsa--gfx900",
    target_consistency: "consistent",
    inspection: "complete",
  });
  expect(result.value.kernels).toHaveLength(1);
});
it("bounds standalone AMD note discovery before retaining metadata", async () => {
  const result = await inspect(
    elfFixture(224, [
      { name: ".note", type: 7, bytes: Buffer.alloc(8 * 1024 * 1024 + 1) },
    ]),
    { analysis: "inventory" },
  );
  if (!result.ok) throw result.error;
  expect(result.value.objects[0]).toMatchObject({
    target: "gfx900",
    inspection: "capacity",
  });
  expect(result.value.objects[0]!.limitations).toContainEqual(
    expect.stringMatching(/note discovery.*8 MiB.*metadata budget/iu),
  );
  expect(result.value.kernels).toEqual([]);
});
it("reads PE raw-size fallback and ELF-host section locations", async () => {
  for (const bytes of [
    peGpuFixture(),
    elfFixture(62, [{ name: ".nv_fatbin", bytes: cudaFixture() }]),
  ]) {
    const result = await inspect(bytes);
    if (!result.ok) throw result.error;
    expect(result.value.kernels).toHaveLength(2);
    expect(result.value.objects[0]!.location.section_index).not.toBeNull();
    expect(result.value.objects[1]!.location.container_id).toBe(
      result.value.objects[0]!.id,
    );
  }
});
it("coalesces aliased CUDA metadata before expanding the temporary index", async () => {
  const bytes = cubinFixture({ globalRecords: 65536, globalAliases: 1024 });
  expect(bytes.length).toBeLessThan(1024 * 1024);
  const result = await inspect(bytes);
  if (!result.ok) throw result.error;
  expect(result.value.objects[0]!.inspection).toBe("complete");
  expect(result.value.kernels).toHaveLength(1);
  expect(result.value.kernels[0]!.registers.physical).toBe(10);
});
it("retains unknown PTX virtual counts and partial payload coverage", async () => {
  const result = await inspect(
    Buffer.from(ptxFixture.replace("%r<9>", "r0, r1, %r<4>, %s<8>")),
  );
  if (!result.ok) throw result.error;
  expect(result.value.kernels[0]!.registers.virtual[0]).toEqual({
    type: ".b32",
    count: 14,
  });
  const unsupported = await inspect(
    Buffer.from(ptxFixture.replace("%r<9>", "%r[4]")),
  );
  if (!unsupported.ok) throw unsupported.error;
  expect(unsupported.value.objects[0]!.inspection).toBe("partial");
  expect(unsupported.value.coverage.payloads).toBe("partial");
  expect(unsupported.value.kernels[0]!.registers.virtual[0]).toEqual({
    type: ".b32",
    count: null,
  });
});
it.each(["spaced", "compact", "mixed"])(
  "counts %s PTX register keywords while retaining byte provenance",
  async (spacing) => {
    const directive = spacing === "spaced" ? ".reg " : ".reg";
    const header = ".version 8.8\n.target sm_80\n// GPU 寄存器 🎯\n";
    const entry = `.entry k() { ${directive}.b32 %r<4>; ${spacing === "mixed" ? ".reg " : directive}.b32 r0, r1, %r4; ${directive}.b64 %rd<2>; ret; }`;
    const source = header + entry;
    const result = await inspect(Buffer.from(source));
    if (!result.ok) throw result.error;
    expect(result.value.objects[0]!.inspection).toBe("complete");
    expect(result.value.coverage.payloads).toBe("complete");
    expect(result.value.ptx_artifacts[0]!.text).toBe(source);
    const kernel = result.value.kernels[0]!;
    expect(kernel.registers.virtual).toEqual([
      { type: ".b32", count: 7 },
      { type: ".b64", count: 2 },
    ]);
    expect(kernel.location).toMatchObject({
      offset: Buffer.byteLength(header),
      size: Buffer.byteLength(entry),
    });
  },
);
it("keeps unsupported compact PTX register types partial", async () => {
  const result = await inspect(
    Buffer.from(ptxFixture.replace(".reg .b32", ".reg.v2.b32")),
  );
  if (!result.ok) throw result.error;
  expect(result.value.objects[0]!.inspection).toBe("partial");
  expect(result.value.coverage.payloads).toBe("partial");
  expect(result.value.kernels[0]!.registers.virtual).toEqual([
    { type: ".v2 .b32", count: null },
    { type: ".b64", count: 5 },
  ]);
});
it.each([64, 65])(
  "counts all %d scalar names in one PTX register list",
  async (count) => {
    const names = Array.from(
      { length: count },
      (_, index) => `%r${index}`,
    ).join(", ");
    const result = await inspect(
      Buffer.from(
        `.version 8.8\n.target sm_80\n.address_size 64\n.entry k() { .reg .b32 ${names}; ret; }\n`,
      ),
    );
    if (!result.ok) throw result.error;
    expect(result.value.objects[0]!.inspection).toBe("complete");
    expect(result.value.coverage.payloads).toBe("complete");
    expect(result.value.kernels[0]!.registers.virtual).toEqual([
      { type: ".b32", count },
    ]);
  },
);
it("retains PTX kernels before and after a long scalar register list", async () => {
  const names = Array.from({ length: 65 }, (_, index) => `%r${index}`).join(
    ", ",
  );
  const result = await inspect(
    Buffer.from(
      `.version 8.8\n.target sm_80\n.address_size 64\n.entry before() { ret; }\n.entry affected() { .reg .b32 ${names}; ret; }\n.entry after() { ret; }\n`,
    ),
  );
  if (!result.ok) throw result.error;
  expect(result.value.objects[0]!.inspection).toBe("complete");
  expect(result.value.coverage.payloads).toBe("complete");
  expect(result.value.kernels.map((kernel) => kernel.name)).toEqual([
    "before",
    "affected",
    "after",
  ]);
  expect(result.value.kernels[1]!.registers.virtual).toEqual([
    { type: ".b32", count: 65 },
  ]);
});
it("retains later PTX kernels when a virtual register total overflows", async () => {
  const result = await inspect(
    Buffer.from(
      ".version 8.8\n.target sm_80\n.address_size 64\n.entry before() { ret; }\n.entry affected() { .reg .b32 %r<9007199254740991>, %s; ret; }\n.entry after() { ret; }\n",
    ),
  );
  if (!result.ok) throw result.error;
  expect(result.value.objects[0]!.inspection).toBe("partial");
  expect(result.value.coverage.payloads).toBe("partial");
  expect(result.value.kernels.map((kernel) => kernel.name)).toEqual([
    "before",
    "affected",
    "after",
  ]);
  expect(result.value.kernels[1]!.registers.virtual).toEqual([
    { type: ".b32", count: null },
  ]);
});
it.each([
  ".entry k { ret; }",
  ".entry k() { ret; }",
  ".entry k .maxntid 1 { ret; }",
])("inspects PTX entry with optional parameters: %s", async (entry) => {
  const result = await inspect(
    Buffer.from(`.version 7.0\n.target sm_80\n.address_size 64\n${entry}`),
  );
  if (!result.ok) throw result.error;
  expect(result.value.objects[0]!.inspection).toBe("complete");
  expect(result.value.coverage.payloads).toBe("complete");
  expect(result.value.kernels).toMatchObject([
    { name: "k", parameter_count: 0, parameter_bytes: 0, parameters: [] },
  ]);
});
it.each([
  ["parameter", ".u64 output", ".u64 .vendor_specific output"],
  ["shared", "scratch[32]", "scratch[]"],
] as const)(
  "marks unknown PTX %s declarations partial while retaining known facts",
  async (kind, from, to) => {
    const bytes = Buffer.from(ptxFixture.replace(from, to));
    const result = await inspect(bytes);
    if (!result.ok) throw result.error;
    expect(result.value.objects[0]!.inspection).toBe("partial");
    expect(result.value.coverage.payloads).toBe("partial");
    expect(result.value.ptx_artifacts[0]!.text).toBe(bytes.toString());
    const kernel = result.value.kernels[0]!;
    expect(kernel.registers.virtual[0]).toEqual({ type: ".b32", count: 9 });
    expect(kernel.limitations.join(" ")).toContain(`PTX ${kind} declarations`);
    if (kind === "parameter") {
      expect(kernel.parameter_count).toBe(2);
      expect(kernel.parameter_bytes).toBeNull();
      expect(
        kernel.parameters.map(({ size, offset }) => [size, offset]),
      ).toEqual([
        [null, null],
        [4, null],
      ]);
      expect(kernel.shared_bytes).toBe(32);
    } else {
      expect(kernel.parameter_bytes).toBe(12);
      expect(kernel.shared_bytes).toBeNull();
    }
  },
);
it.each([
  ".ptr .global",
  ".ptr .global .align 16",
  ".ptr.global.align 16",
  ".ptr .global.align 16",
  ".ptr.global .align 16",
])(
  "keeps PTX pointer qualifiers %s complete through the provider",
  async (qualifiers) => {
    const bytes = Buffer.from(
      ptxFixture.replace(".u64 output", `.u64 ${qualifiers} output`),
    );
    const result = await inspect(bytes);
    if (!result.ok) throw result.error;
    expect(result.value.objects[0]!.inspection).toBe("complete");
    expect(result.value.coverage.payloads).toBe("complete");
    expect(result.value.ptx_artifacts[0]!.text).toBe(bytes.toString());
    expect(result.value.kernels[0]).toMatchObject({
      parameter_count: 2,
      parameter_bytes: 12,
      parameters: [
        { name: "output", offset: 0, size: 8 },
        { name: "value", offset: 8, size: 4 },
      ],
    });
  },
);
it.each([".align 8 .b8", ".b8 .align 8"])(
  "retains PTX array parameter identity and layout with %s",
  async (type) => {
    const bytes = Buffer.from(
      ptxFixture.replace(".u64 output", `${type} payload[8]`),
    );
    const result = await inspect(bytes);
    if (!result.ok) throw result.error;
    expect(result.value.objects[0]!.inspection).toBe("complete");
    expect(result.value.coverage.payloads).toBe("complete");
    expect(result.value.ptx_artifacts[0]!.text).toBe(bytes.toString());
    expect(result.value.kernels[0]).toMatchObject({
      parameter_count: 2,
      parameter_bytes: 12,
      parameters: [
        { name: "payload", type: ".b8", offset: 0, size: 8 },
        { name: "value", offset: 8, size: 4 },
      ],
    });
  },
);
it.each(["9007199254740991", "0x1fffffffffffff"])(
  "retains PTX parameter facts when aligning an extent of %s exceeds the exact range",
  async (extent) => {
    const result = await inspect(
      Buffer.from(
        `.version 8.0
.target sm_80
.entry wide(.param .b8 payload[${extent}], .param .u32 count, .param .u8 tail) { ret; }
.entry later(.param .u32 value) { ret; }`,
      ),
    );
    if (!result.ok) throw result.error;
    expect(result.value.coverage.payloads).toBe("partial");
    expect(result.value.kernels).toMatchObject([
      {
        name: "wide",
        parameter_bytes: null,
        parameters: [
          { name: "payload", offset: 0, size: 9007199254740991 },
          { name: "count", offset: null, size: 4 },
          { name: "tail", offset: null, size: 1 },
        ],
      },
      {
        name: "later",
        parameter_bytes: 4,
        parameters: [{ name: "value", offset: 0, size: 4 }],
      },
    ]);
  },
);

it.each([
  ".b8 .align 3",
  ".b8 .align 4503599627370495",
  ".align 8 .b8 .align 8",
])(
  "retains PTX names and partial layout for unsupported alignment %s",
  async (type) => {
    const bytes = Buffer.from(
      ptxFixture.replace(".u64 output", `${type} payload[8]`),
    );
    const result = await inspect(bytes);
    if (!result.ok) throw result.error;
    expect(result.value.objects[0]!.inspection).toBe("partial");
    expect(result.value.coverage.payloads).toBe("partial");
    expect(result.value.kernels[0]).toMatchObject({
      parameter_count: 2,
      parameter_bytes: null,
      parameters: [
        { name: "payload", type: ".b8", offset: null, size: null },
        { name: "value", offset: null, size: 4 },
      ],
    });
  },
);
it.each(["whitespace", "comment"] as const)(
  "recognizes standalone PTX after more than 64 KiB of leading %s",
  async (kind) => {
    const prefix =
      kind === "whitespace"
        ? " ".repeat(70 * 1024)
        : `/*${"x".repeat(70 * 1024)}*/\n`;
    const bytes = Buffer.from(prefix + ptxFixture);
    const inventory = await inspect(bytes, { analysis: "inventory" });
    const selected = await inspect(bytes, { targets: ["sm_80"] });
    if (!inventory.ok) throw inventory.error;
    if (!selected.ok) throw selected.error;
    expect(inventory.value.objects[0]!.target).toBe("sm_80");
    expect(selected.value.kernels).toHaveLength(1);
    expect(selected.value.kernels[0]!.location.offset).toBeGreaterThan(
      64 * 1024,
    );
  },
);
it("uses a later module target when selecting standalone PTX", async () => {
  const bytes = Buffer.from(
    ".version 8.8\n.target sm_80\n.entry first() { ret; }\n.target sm_90\n",
  );
  const inventory = await inspect(bytes, { analysis: "inventory" });
  const selected = await inspect(bytes, { targets: ["sm_90"] });
  if (!inventory.ok) throw inventory.error;
  if (!selected.ok) throw selected.error;
  expect(inventory.value.objects[0]!.target).toBe("sm_90");
  expect(selected.value.kernels.map(({ name }) => name)).toEqual(["first"]);
});
it("reports invalid standalone PTX encoding in inventory and kernel inspection", async () => {
  const header = Buffer.from(
    ".version 8.0\n.target sm_80\n.address_size 64\n// ",
  );
  const entry = Buffer.from("\n.visible .entry hello() { ret; }\n");
  const malformed = Buffer.concat([header, Buffer.from([0xff]), entry]);
  const valid = Buffer.concat([header, Buffer.from("café"), entry]);
  for (const analysis of ["inventory", "kernels"] as const) {
    const result = await inspect(malformed, { analysis });
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      format: "ptx",
      artifact: {
        sha256: createHash("sha256").update(malformed).digest("hex"),
      },
      coverage: {
        discovery: "partial",
        payloads: analysis === "kernels" ? "partial" : "not-requested",
      },
      objects: [{ kind: "ptx", target: null, inspection: "malformed" }],
      kernels: [],
      ptx_artifacts: [],
    });
    expect(result.value.objects[0]!.limitations).toContain(
      "PTX is not valid UTF-8 text",
    );

    const control = await inspect(valid, { analysis });
    if (!control.ok) throw control.error;
    expect(control.value.coverage.discovery).toBe("complete");
    expect(control.value.objects[0]!.target).toBe("sm_80");
    if (analysis === "kernels") {
      expect(control.value.kernels.map(({ name }) => name)).toEqual(["hello"]);
      expect(
        Buffer.from(control.value.ptx_artifacts[0]!.text).equals(valid),
      ).toBe(true);
    }
  }
});

it.each([
  [
    "an unmatched close",
    ".version 8.0\n.target sm_80\n.entry k() { ret; }}\n.target sm_90\n",
  ],
  // The first target follows the stray close, so recognition depends on the
  // scan continuing past it.
  ["a close before the first target", ".version 8.0\n}\n.target sm_90\n"],
  [
    "a truncated entry body",
    ".version 8.0\n.target sm_80\n.target sm_90\n.entry k() { ret;\n",
  ],
])("keeps the standalone PTX target unknown after %s", async (_label, text) => {
  const malformed = Buffer.from(text);
  const valid = Buffer.from(
    ".version 8.0\n.target sm_80\n.entry k() { ret; }\n.target sm_90\n",
  );
  for (const analysis of ["inventory", "kernels"] as const) {
    const result = await inspect(malformed, { analysis });
    if (!result.ok) throw result.error;
    expect(result.value.coverage.discovery).toBe("partial");
    expect(result.value.objects).toMatchObject([{ kind: "ptx", target: null }]);
    expect(result.value.objects[0]!.inspection).not.toBe("complete");
    expect(result.value.objects[0]!.limitations).toContain(
      "Malformed PTX text prevents complete target discovery.",
    );

    const control = await inspect(valid, { analysis });
    if (!control.ok) throw control.error;
    expect(control.value.coverage.discovery).toBe("complete");
    expect(control.value.objects).toMatchObject([
      {
        kind: "ptx",
        target: "sm_90",
        inspection: analysis === "kernels" ? "complete" : "inventory",
        limitations: [],
      },
    ]);
  }
});

it("keeps a UTF-8 character split by the standalone PTX scan budget unexamined", async () => {
  const budget = 16 * 1024 * 1024;
  const header = Buffer.from(".version 8.0\n.target sm_80\n// ");
  const bytes = Buffer.concat([
    header,
    Buffer.alloc(budget - header.length - 1, 0x20),
    Buffer.from("é\n"),
  ]);
  const result = await inspect(bytes, { analysis: "inventory" });
  if (!result.ok) throw result.error;
  expect(result.value.coverage.discovery).toBe("partial");
  expect(result.value.objects).toMatchObject([
    { kind: "ptx", target: null, inspection: "partial" },
  ]);
  expect(result.value.objects[0]!.limitations).toEqual([
    "PTX target scan reached the 16 MiB text budget before all module directives were examined.",
  ]);
});
it.each(["truncated", "invalid", "extension"] as const)(
  "retains earlier AMD kernel declarations after a later %s note",
  async (kind) => {
    const tail = Buffer.alloc(kind === "truncated" ? 3 : 24);
    if (kind !== "truncated") {
      tail.writeUInt32LE(7, 0);
      tail.writeUInt32LE(kind === "invalid" ? 1 : 3, 4);
      tail.writeUInt32LE(32, 8);
      tail.write("AMDGPU\0", 12);
      tail[20] = kind === "invalid" ? 0xc1 : 0xd4;
    }
    const payloadTarget = "amdgcn-amd-amdhsa--gfx900";
    for (const { bytes, target, consistency } of [
      {
        bytes: amdFixture(false, tail),
        target: payloadTarget,
        consistency: "single-source",
      },
      {
        bytes: hipFixture(amdFixture(false, tail)),
        target: "gfx900",
        consistency: "consistent",
      },
    ]) {
      const result = await inspect(bytes);
      if (!result.ok) throw result.error;
      expect(result.value.kernels).toHaveLength(1);
      expect(result.value.kernels[0]).toMatchObject({
        name: "add_one",
        parameter_bytes: 12,
        registers: { sgpr: 6, vgpr: 2 },
      });
      expect(
        result.value.objects.find((row) => row.kind === "amdgpu")!.inspection,
      ).toBe(kind === "extension" ? "unsupported" : "malformed");
      const identity = {
        target,
        payload_target: payloadTarget,
        target_consistency: consistency,
      };
      expect(
        result.value.objects.find((row) => row.kind === "amdgpu"),
      ).toMatchObject(identity);
      expect(result.value.coverage.payloads).toBe("partial");
      const selected = await inspect(bytes, { targets: [target] });
      if (!selected.ok) throw selected.error;
      expect(
        selected.value.objects.find((row) => row.kind === "amdgpu"),
      ).toMatchObject(identity);
      expect(selected.value.kernels).toEqual(result.value.kernels);
      expect(selected.value.coverage.payloads).toBe("partial");
      const skipped = await inspect(bytes, {
        targets: [target === "gfx900" ? payloadTarget : "gfx900"],
      });
      if (!skipped.ok) throw skipped.error;
      expect(
        skipped.value.objects.find((row) => row.kind === "amdgpu"),
      ).toMatchObject(
        target === payloadTarget
          ? {
              ...identity,
              inspection: kind === "extension" ? "unsupported" : "malformed",
            }
          : {
              target,
              payload_target: null,
              target_consistency: "unexamined",
              inspection: "not-selected",
            },
      );
      expect(skipped.value.kernels).toEqual([]);
    }
  },
);
it("bounds cumulative CUDA records across separate in-range metadata sections", async () => {
  const record = Buffer.from("042f0800010000000a000000", "hex"),
    records = Buffer.alloc(record.length * 131073);
  for (let offset = 0; offset < records.length; offset += record.length)
    record.copy(records, offset);
  const result = await inspect(
    elfFixture(190, [
      { name: ".nv.info", type: 0x70000000, bytes: records },
      { name: ".nv.info", type: 0x70000000, bytes: records },
    ]),
  );
  if (!result.ok) throw result.error;
  expect(result.value.objects[0]!.inspection).toBe("capacity");
  expect(result.value.objects[0]!.limitations.join(" ")).toContain(
    "aggregate record/symbol visits",
  );
});
it.each(["section-names", "symbols"] as const)(
  "retains partial CUBIN coverage when %s are unavailable",
  async (missing) => {
    const bytes = cubinFixture();
    if (missing === "section-names") bytes.writeUInt16LE(0, 62);
    else bytes.writeUInt32LE(1, Number(bytes.readBigUInt64LE(40)) + 3 * 64 + 4);
    const result = await inspect(bytes);
    if (!result.ok) throw result.error;
    expect(result.value.objects[0]!.inspection).toBe("partial");
    expect(result.value.coverage.payloads).toBe("partial");
    expect(result.value.kernels).toHaveLength(missing === "symbols" ? 0 : 1);
    expect(result.value.objects[0]!.limitations.join(" ")).toContain(
      missing === "symbols"
        ? "kernel declaration coverage is unknown"
        : "named metadata coverage is partial",
    );
  },
);
it.each(["add_one", "kérnel_日本"])(
  "decodes UTF-8 CUBIN symbol name %s without a name limitation",
  async (name) => {
    const result = await inspect(cubinFixture({ name }));
    if (!result.ok) throw result.error;
    const [kernel] = result.value.kernels;
    expect(kernel).toMatchObject({ name, symbol: name });
    expect(kernel!.limitations.join(" ")).not.toContain("not valid UTF-8");
  },
);
it("preserves non-UTF-8 CUBIN symbol bytes in the kernel name", async () => {
  const bytes = cubinFixture();
  const symbolName = bytes.indexOf(Buffer.from("\0add_one\0"));
  expect(symbolName).toBeGreaterThanOrEqual(0);
  bytes[symbolName + 1] = 0xff;
  const result = await inspect(bytes);
  if (!result.ok) throw result.error;
  const [kernel] = result.value.kernels;
  expect(kernel?.name).toBe("ÿdd_one");
  expect(kernel!.limitations).toContain(
    `CUDA kernel symbol name is not valid UTF-8; name shows its bytes as Latin-1 (base64 ${Buffer.from("\xffdd_one", "latin1").toString("base64")})`,
  );
});

it.each([9, 10])(
  "preserves parameters and register coverage for text count %d",
  async (textRegisters) => {
    const name = "kernel_" + "argument".repeat(64);
    const result = await inspect(
      cubinFixture({ name, textRegisters, globalRegisters: 10 }),
    );
    if (!result.ok) throw result.error;
    const conflict = textRegisters !== 10;
    expect(result.value.kernels[0]).toMatchObject({
      name,
      parameter_count: 2,
      registers: { physical: conflict ? null : 10 },
    });
    expect(result.value.objects[0]!.inspection).toBe(
      conflict ? "partial" : "complete",
    );
    expect(result.value.coverage.payloads).toBe(
      conflict ? "partial" : "complete",
    );
    expect(
      result.value.kernels[0]!.limitations.some((value) =>
        value.includes("Conflicting"),
      ),
    ).toBe(conflict);
  },
);
it("iterates flat concatenated fatbins beyond the genuine container nesting limit", async () => {
  const result = await inspect(
    Buffer.concat(Array.from({ length: 20 }, () => cudaFixture())),
  );
  if (!result.ok) throw result.error;
  expect(result.value.objects).toHaveLength(40);
  expect(result.value.kernels).toHaveLength(40);
  expect(result.value.coverage.discovery).toBe("complete");
});
it("reports checksum corruption and unknown compression as partial, retaining known entries", async () => {
  const corrupt = ccobFixture();
  corrupt[16] = corrupt[16]! ^ 1;
  const result = await inspect(corrupt);
  if (!result.ok) throw result.error;
  expect(result.value.coverage.discovery).toBe("partial");
  expect(result.value.objects[0]!.inspection).toBe("malformed");
  const unknown = ccobFixture();
  unknown.writeUInt16LE(99, 6);
  const unsupported = await inspect(unknown);
  if (!unsupported.ok) throw unsupported.error;
  expect(unsupported.value.objects[0]!.inspection).toBe("unsupported");
});
it("rejects out-of-range bundle entries without guessing a payload", async () => {
  const bytes = hipFixture();
  bytes.writeBigUInt64LE(BigInt(bytes.length + 1), 32);
  const result = await inspect(bytes);
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisTargetFailureError" },
  });
});

it("preserves standalone PTX BOM and trailing NUL bytes in the retained text artifact", async () => {
  const bytes = Buffer.from("\uFEFF" + ptxFixture + "\0");
  const result = await inspect(bytes);
  if (!result.ok) throw result.error;
  expect(
    Buffer.compare(Buffer.from(result.value.ptx_artifacts[0]!.text), bytes),
  ).toBe(0);
  expect(result.value.ptx_artifacts[0]!.byte_length).toBe(bytes.length);
});
it("rejects a changed full-file identity before applying positional object selection", async () => {
  const bytes = cudaFixture();
  const result = await inspect(bytes, {
    expected_sha256: "0".repeat(64),
    object_ids: ["file@10"],
  });
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisArtifactChangedError" },
  });
});
it("iterates mixed plain/CCOB bundles without counting flat records as nesting", async () => {
  const records = Array.from({ length: 20 }, (_, index) =>
    index % 2 === 0 ? hipFixture() : ccobFixture(),
  );
  const result = await inspect(Buffer.concat(records));
  if (!result.ok) throw result.error;
  expect(result.value.kernels).toHaveLength(20);
  expect(result.value.coverage.discovery).toBe("complete");
});
it("does not recognize a CCOB signature after its first byte is corrupted", async () => {
  const bytes = ccobFixture(3, "zlib");
  bytes[0] = bytes[0]! | 0x80;
  const result = await inspect(bytes);
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisTargetFailureError" },
  });
});
it("requires the PTX version directive before any module content", async () => {
  const result = await inspect(Buffer.from(`unexpected-prefix ${ptxFixture}`));
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisTargetFailureError" },
  });
});
it("retains an embedded CCOB with a corrupted signature as unsupported", async () => {
  const bytes = ccobFixture(3, "zlib");
  bytes[0] = bytes[0]! | 0x80;
  const result = await inspect(
    elfFixture(62, [{ name: ".hip_fatbin", bytes }]),
  );
  if (!result.ok) throw result.error;
  expect(result.value.coverage.discovery).toBe("partial");
  expect(result.value.kernels).toEqual([]);
  expect(result.value.objects).toContainEqual(
    expect.objectContaining({
      kind: "native-section",
      inspection: "unsupported",
      limitations: expect.arrayContaining([
        "No supported CUDA/HIP container or PTX declarations were identified",
      ]),
    }),
  );
});
it.each([
  ["unknown COFF machine", 0xffff],
  ["x86 machine with a PE32+ optional header", 0x14c],
] as const)(
  "discovers PE GPU sections with %s",
  async (_description, machine) => {
    const bytes = peGpuFixture();
    const pe = bytes.readUInt32LE(60);
    bytes.writeUInt16LE(machine, pe + 4);
    const result = await inspect(bytes);
    if (!result.ok) throw result.error;
    expect(result.value.format).toBe("pe");
    expect(result.value.artifact.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(result.value.coverage).toMatchObject({
      discovery: "complete",
      payloads: "complete",
    });
    expect(result.value.kernels.map(({ name }) => name)).toEqual([
      "add_one",
      "add_one",
    ]);
    expect(result.value.ptx_artifacts[0]!.text).toBe(ptxFixture);
  },
);
it("does not dispatch a high-bit-corrupted DOS signature to the PE parser", async () => {
  const bytes = peGpuFixture(Buffer.from(ptxFixture));
  bytes[0] = bytes[0]! | 0x80;
  const result = await inspect(bytes);
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisTargetFailureError" },
  });
});
it("preserves the PE layout refusal at the GPU provider boundary", async () => {
  const result = await inspect(pe(0x014c, 4));
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisTargetFailureError",
      message: expect.stringContaining("overlapping PE header"),
    },
  });
});
it.each(["zlib", "zstd"] as const)(
  "uses each legacy CCOB v1 %s stream boundary across alignment padding",
  async (codec) => {
    const first = ccobFixture(1, codec),
      second = ccobFixture(2, "zlib"),
      padding = Buffer.alloc((8 - (first.length % 8)) % 8);
    const result = await inspect(Buffer.concat([first, padding, second]));
    if (!result.ok) throw result.error;
    const bundles = result.value.objects.filter(
      ({ kind }) => kind === "hip-bundle",
    );
    expect(bundles).toHaveLength(2);
    expect(
      bundles.map(({ inspection, decoded_size }) => [inspection, decoded_size]),
    ).toEqual([
      ["complete", expect.any(Number)],
      ["complete", expect.any(Number)],
    ]);
    expect(bundles[0]!.sha256).toBe(bundles[1]!.sha256);
    expect(bundles[0]!.encoded_size).toBe(first.length - 20);
    expect(bundles[0]!.location.size).toBe(first.length - 20);
    expect(bundles[1]!.metadata_location.offset).toBe(
      first.length + padding.length,
    );
    expect(result.value.kernels).toHaveLength(2);
    expect(result.value.coverage.discovery).toBe("complete");
  },
);
it("keeps a later CCOB bundle after a truncated legacy v1 stream", async () => {
  const truncated = ccobFixture(1, "zlib").subarray(0, -1),
    later = ccobFixture(2, "zlib");
  const result = await inspect(Buffer.concat([truncated, later]));
  if (!result.ok) throw result.error;
  const bundles = result.value.objects.filter(
    ({ kind }) => kind === "hip-bundle",
  );
  expect(bundles).toHaveLength(2);
  expect(bundles.map(({ inspection }) => inspection)).toEqual([
    "malformed",
    "complete",
  ]);
  expect(result.value.kernels).toHaveLength(1);
  expect(result.value.coverage.discovery).toBe("partial");
  expect(bundles[0]!.limitations.join(" ")).toContain(
    "uncertain recovery candidate",
  );
});
it.each(["checksum", "decoded-size"] as const)(
  "preserves a completed v1 codec extent after a bad %s declaration",
  async (declaration) => {
    const bundle = hipFixture(
        Buffer.from("ordinary CCOB marker"),
        "host-other",
      ),
      compressed = deflateSync(bundle, { level: 0 }),
      header = Buffer.from(ccobFixture(1, "zlib", bundle).subarray(0, 20));
    if (declaration === "checksum") header[12] = header[12]! ^ 1;
    else header.writeUInt32LE(bundle.length + 1, 8);
    const first = Buffer.concat([header, compressed]);
    const result = await inspect(
      Buffer.concat([first, ccobFixture(2, "zlib")]),
    );
    if (!result.ok) throw result.error;
    const wrappers = result.value.objects.filter(
      ({ kind }) => kind === "hip-bundle",
    );
    expect(wrappers.map(({ inspection }) => inspection)).toEqual([
      "malformed",
      "complete",
    ]);
    expect(wrappers[0]).toMatchObject({
      encoded_size: compressed.length,
      location: { size: compressed.length },
    });
    expect(wrappers[0]!.limitations.join(" ")).not.toContain("recovery");
    expect(wrappers[1]!.metadata_location.offset).toBe(first.length);
    expect(result.value.coverage.discovery).toBe("partial");
  },
);
it("continues at the declared CCOB boundary after an unsupported codec", async () => {
  const unknown = ccobFixture();
  unknown.writeUInt16LE(99, 6);
  const result = await inspect(Buffer.concat([unknown, ccobFixture()]));
  if (!result.ok) throw result.error;
  expect(result.value.kernels).toHaveLength(1);
  expect(result.value.coverage.discovery).toBe("partial");
});

it.each([
  { label: "exact JSON integer", decoded: 1n << 28n, projected: 1 << 28 },
  {
    label: "outside exact JSON integer range",
    decoded: 1n << 53n,
    projected: null,
  },
])(
  "keeps later CCOB v3 bundles after a decoded size $label exceeds capacity",
  async ({ decoded, projected }) => {
    const first = ccobFixture(3, "zlib");
    first.writeBigUInt64LE(decoded, 16);
    const result = await inspect(
      Buffer.concat([first, ccobFixture(3, "zlib")]),
    );
    if (!result.ok) throw result.error;
    const wrappers = result.value.objects.filter(
      ({ kind }) => kind === "hip-bundle",
    );
    expect(wrappers).toMatchObject([
      {
        inspection: "capacity",
        encoded_size: first.length - 32,
        decoded_size: projected,
        location: { offset: 32, size: first.length - 32 },
      },
      { inspection: "complete", metadata_location: { offset: first.length } },
    ]);
    if (projected === null)
      expect(wrappers[0]?.limitations).toContain(
        `Declared decoded size is ${String(decoded)} bytes, outside the exact integer range of decoded_size`,
      );
    expect(result.value.coverage.discovery).toBe("partial");
    expect(result.value.kernels.map(({ name }) => name)).toEqual(["add_one"]);
  },
);

it("refuses escaped PTX report expansion while preserving bounded interrupted facts", async () => {
  const text = ptxFixture + "\n//" + "\u0001".repeat(3 * 1024 * 1024);
  const result = await inspect(Buffer.from(text));
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError" },
  });
  if (result.ok) throw new Error("expected representation capacity refusal");
  expect(projectAnalysisError(result.error)).toMatchObject({
    details: {
      reported_limits: {
        boundary: "gpu-retained-report-bytes",
        maximum: 16_777_216,
      },
    },
  });
  const partial = gpuCodeObjectsPartialSchema.parse(
    parseEvidence(result.error.partialObservation).normalized_result,
  );
  expect(partial.ptx_artifacts).toEqual([]);
  expect(partial.objects).toHaveLength(1);
  expect(partial.artifact.sha256).toBeNull();
});

it("distinguishes impossible Clang bundle counts from a framed over-capacity directory", async () => {
  const empty = Buffer.alloc(32);
  Buffer.from("__CLANG_OFFLOAD_BUNDLE__").copy(empty);
  const emptyResult = await inspect(empty, { analysis: "inventory" });
  if (!emptyResult.ok) throw emptyResult.error;
  expect(emptyResult.value.objects).toEqual([]);
  const truncated = hipFixture().subarray(0, 32);
  for (const count of [65537n, 0xffffffffffffffffn]) {
    const bytes = Buffer.from(truncated);
    bytes.writeBigUInt64LE(count, 24);
    const result = await inspect(bytes, { analysis: "inventory" });
    if (result.ok) throw new Error("Expected malformed directory");
    expect(result.error).toMatchObject({
      _tag: "AnalysisTargetFailureError",
    });
  }
  const framed = Buffer.alloc(32 + 65537 * 25);
  Buffer.from("__CLANG_OFFLOAD_BUNDLE__").copy(framed);
  framed.writeBigUInt64LE(65537n, 24);
  for (let index = 0; index < 65537; index++) {
    const row = 32 + index * 25;
    framed.writeBigUInt64LE(BigInt(framed.length), row);
    framed.writeBigUInt64LE(1n, row + 16);
    framed[row + 24] = 0x78;
  }
  const result = await inspect(framed, { analysis: "inventory" });
  if (result.ok) throw new Error("Expected directory capacity failure");
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "resource_constraint",
    retryable: false,
    details: {
      resource: "memory",
      reported_limits: { boundary: "hip-bundle-entries", maximum: 65_536 },
    },
  });
});

it("checks Clang bundle ID bounds before the retained directory allowance", async () => {
  const name = "host-" + "x".repeat(65_537 - 5);
  const header = Buffer.alloc(56);
  header.write("__CLANG_OFFLOAD_BUNDLE__");
  header.writeBigUInt64LE(1n, 24);
  header.writeBigUInt64LE(BigInt(header.length + name.length), 32);
  header.writeBigUInt64LE(1n, 40);
  header.writeBigUInt64LE(BigInt(name.length), 48);
  const framed = Buffer.concat([header, Buffer.from(name), Buffer.alloc(1)]);
  const limited = await inspect(framed, { analysis: "inventory" });
  if (limited.ok) throw new Error("Expected a directory capacity failure");
  expect(projectAnalysisError(limited.error)).toMatchObject({
    code: "resource_constraint",
    retryable: false,
    details: {
      resource: "memory",
      reported_limits: {
        boundary: "hip-bundle-id-bytes",
        maximum: 65_536,
        maximum_object_bytes: 134_217_728,
        maximum_report_bytes: 16_777_216,
      },
    },
  });

  const short = Buffer.from(header);
  short.writeBigUInt64LE(BigInt(short.length), 32);
  short.writeBigUInt64LE(0n, 40);
  const overlaps = Buffer.from(framed);
  overlaps.writeBigUInt64LE(BigInt(header.length + 1), 32);
  for (const bytes of [short, overlaps]) {
    const result = await inspect(bytes, { analysis: "inventory" });
    if (result.ok) throw new Error("Expected a malformed bundle directory");
    expect(result.error).toMatchObject({
      _tag: "AnalysisTargetFailureError",
    });
  }
});

it("reports aggregate Clang directory capacity when every ID fits", async () => {
  const count = 256;
  const idBytes = 65_536;
  const entryBytes = 24 + idBytes;
  const directoryEnd = 32 + count * entryBytes;
  const framed = Buffer.alloc(directoryEnd + 1, 0x78);
  framed.write("__CLANG_OFFLOAD_BUNDLE__");
  framed.writeBigUInt64LE(BigInt(count), 24);
  for (let index = 0; index < count; index++) {
    const row = 32 + index * entryBytes;
    framed.writeBigUInt64LE(BigInt(directoryEnd), row);
    framed.writeBigUInt64LE(1n, row + 8);
    framed.writeBigUInt64LE(BigInt(idBytes), row + 16);
  }
  const result = await inspect(framed, { analysis: "inventory" });
  if (result.ok) throw new Error("Expected directory capacity failure");
  expect(projectAnalysisError(result.error)).toMatchObject({
    details: {
      reported_limits: {
        boundary: "hip-bundle-directory-bytes",
        maximum: 16_777_216,
      },
      limit: {
        control_kind: "parameter",
        parameter: "max_report_bytes",
        effective_value: 16_777_216,
      },
      refusal: {
        kind: "adjustable_budget",
        control: "max_report_bytes",
      },
    },
  });
});

it("enforces per-call GPU budgets and recovers when raised", async () => {
  const limitedReport = await inspect(Buffer.from(ptxFixture), {
    analysis: "kernels",
    max_report_bytes: 64,
  });
  if (limitedReport.ok) throw new Error("Expected max_report_bytes refusal");
  expect(projectAnalysisError(limitedReport.error)).toMatchObject({
    code: "resource_constraint",
    retryable: false,
    details: {
      limit: {
        control_kind: "parameter",
        parameter: "max_report_bytes",
        effective_value: 64,
        unit: "bytes",
        maximum: 16 * 1024 * 1024,
        default_value: 16 * 1024 * 1024,
      },
      refusal: {
        kind: "adjustable_budget",
        operation: "inspect_gpu_code_objects",
        control: "max_report_bytes",
      },
    },
  });

  // Exercise max_report_bytes past constructor overhead (after initial facts are retained).
  const paddedPtx = Buffer.from(ptxFixture + "\n//" + "a".repeat(4096));
  const limitedReportRetention = await inspect(paddedPtx, {
    analysis: "kernels",
    max_report_bytes: 2048,
  });
  if (limitedReportRetention.ok)
    throw new Error("Expected post-constructor max_report_bytes refusal");
  expect(projectAnalysisError(limitedReportRetention.error)).toMatchObject({
    code: "resource_constraint",
    details: {
      limit: {
        control_kind: "parameter",
        parameter: "max_report_bytes",
        effective_value: 2048,
      },
      refusal: {
        kind: "adjustable_budget",
        control: "max_report_bytes",
      },
    },
  });

  const raisedReport = await inspect(paddedPtx, {
    analysis: "kernels",
    max_report_bytes: 1024 * 1024,
  });
  expect(raisedReport.ok).toBe(true);

  const limitedToken = await inspect(hipFixture(), {
    analysis: "inventory",
    max_token_bytes: 4,
  });
  if (limitedToken.ok) throw new Error("Expected max_token_bytes refusal");
  expect(projectAnalysisError(limitedToken.error)).toMatchObject({
    code: "resource_constraint",
    details: {
      limit: {
        control_kind: "parameter",
        parameter: "max_token_bytes",
        effective_value: 4,
        maximum: 65_536,
        unit: "bytes",
      },
      refusal: {
        kind: "adjustable_budget",
        control: "max_token_bytes",
      },
    },
  });

  const limitedEntries = await inspect(hipFixture(), {
    analysis: "inventory",
    max_parser_entries: 1,
  });
  if (limitedEntries.ok) throw new Error("Expected max_parser_entries refusal");
  expect(projectAnalysisError(limitedEntries.error)).toMatchObject({
    code: "resource_constraint",
    details: {
      limit: {
        control_kind: "parameter",
        parameter: "max_parser_entries",
        effective_value: 1,
        maximum: 65_536,
        unit: "count",
      },
      refusal: {
        kind: "adjustable_budget",
        control: "max_parser_entries",
      },
    },
  });

  const recoveredHip = await inspect(hipFixture(), {
    analysis: "inventory",
    max_parser_entries: 16,
    max_token_bytes: 128,
  });
  expect(recoveredHip.ok).toBe(true);

  // max_object_bytes: standalone PTX refusal & recovery.
  const limitedObject = await inspect(Buffer.from(ptxFixture), {
    analysis: "kernels",
    max_object_bytes: 64,
  });
  if (limitedObject.ok) throw new Error("Expected max_object_bytes refusal");
  expect(projectAnalysisError(limitedObject.error)).toMatchObject({
    code: "resource_constraint",
    details: {
      limit: {
        control_kind: "parameter",
        parameter: "max_object_bytes",
        effective_value: 64,
        maximum: 128 * 1024 * 1024,
        unit: "bytes",
      },
      refusal: {
        kind: "adjustable_budget",
        control: "max_object_bytes",
      },
    },
  });
  const recoveredObject = await inspect(Buffer.from(ptxFixture), {
    analysis: "kernels",
    max_object_bytes: 4096,
  });
  expect(recoveredObject.ok).toBe(true);

  // max_work_bytes: per-object capacity limitation names max_work_bytes and recovers when raised.
  const limitedWork = await inspect(cudaFixture("none"), {
    analysis: "kernels",
    max_work_bytes: 32,
  });
  if (!limitedWork.ok) throw limitedWork.error;
  expect(limitedWork.value.coverage.payloads).toBe("partial");
  expect(
    limitedWork.value.objects.some(
      (row) =>
        row.inspection === "capacity" &&
        row.limitations.some((note) =>
          note.includes("(parameter: max_work_bytes)"),
        ),
    ),
  ).toBe(true);
  const recoveredWork = await inspect(cudaFixture("none"), {
    analysis: "kernels",
    max_work_bytes: 1024 * 1024,
  });
  if (!recoveredWork.ok) throw recoveredWork.error;
  expect(recoveredWork.value.coverage.payloads).toBe("complete");

  // max_structure_bytes: ELF section directory refusal & recovery.
  const amdBytes = amdFixture();
  const limitedStructure = await inspect(amdBytes, {
    analysis: "inventory",
    max_structure_bytes: 64,
  });
  if (limitedStructure.ok)
    throw new Error("Expected max_structure_bytes refusal");
  expect(projectAnalysisError(limitedStructure.error)).toMatchObject({
    code: "resource_constraint",
    details: {
      limit: {
        control_kind: "parameter",
        parameter: "max_structure_bytes",
        effective_value: 64,
        maximum: 512 * 1024 * 1024,
        unit: "bytes",
      },
      refusal: {
        kind: "adjustable_budget",
        control: "max_structure_bytes",
      },
    },
  });
  const recoveredStructure = await inspect(amdBytes, {
    analysis: "inventory",
    max_structure_bytes: 65_536,
  });
  expect(recoveredStructure.ok).toBe(true);

  // max_metadata_bytes & max_parser_visits on AMDGPU metadata note.
  const limitedMetadata = await inspect(amdBytes, {
    analysis: "kernels",
    max_metadata_bytes: 16,
  });
  if (!limitedMetadata.ok) throw limitedMetadata.error;
  expect(limitedMetadata.value.objects[0]).toMatchObject({
    inspection: "capacity",
    limitations: expect.arrayContaining([
      expect.stringContaining("(parameter: max_metadata_bytes)"),
    ]),
  });

  const limitedVisits = await inspect(amdBytes, {
    analysis: "kernels",
    max_parser_visits: 2,
  });
  if (!limitedVisits.ok) throw limitedVisits.error;
  expect(limitedVisits.value.objects[0]).toMatchObject({
    inspection: "capacity",
    limitations: expect.arrayContaining([
      expect.stringContaining("(parameter: max_parser_visits)"),
    ]),
  });

  const recoveredAmd = await inspect(amdBytes, {
    analysis: "kernels",
    max_metadata_bytes: 65_536,
    max_parser_visits: 4096,
  });
  if (!recoveredAmd.ok) throw recoveredAmd.error;
  expect(recoveredAmd.value.objects[0]?.inspection).toBe("complete");
  expect(recoveredAmd.value.kernels.length).toBeGreaterThan(0);
});

it("respects max_object_bytes during container scanning and full-file digesting", async () => {
  // Trailing NUL bytes past a HIP bundle must be scanned in chunks <= max_object_bytes
  // on both readBounded and read fallback paths.
  const paddedSourceBytes = Buffer.concat([
    Buffer.alloc(2048),
    Buffer.from("CCOB"),
  ]);
  const boundedCalls: Array<{ size: number; limit: number }> = [];
  const nextOffset = await nextGpuContainerOffset(
    {
      size: paddedSourceBytes.length,
      containerId: null,
      maxObjectBytes: 512,
      async read(offset, size) {
        return paddedSourceBytes.subarray(offset, offset + size);
      },
      async readBounded(offset, size, limit) {
        boundedCalls.push({ size, limit });
        return paddedSourceBytes.subarray(offset, offset + size);
      },
    },
    0,
  );
  expect(nextOffset).toBe(2048);
  expect(boundedCalls.length).toBeGreaterThan(1);
  for (const call of boundedCalls) {
    expect(call.size).toBeLessThanOrEqual(512);
    expect(call.limit).toBeLessThanOrEqual(512);
  }

  const smallBundle = hipFixture(Buffer.from("x"), "host-x86_64");
  const paddedBundle = Buffer.concat([smallBundle, Buffer.alloc(2048)]);
  const scanned = await inspect(paddedBundle, {
    analysis: "inventory",
    max_object_bytes: 512,
  });
  if (!scanned.ok) throw scanned.error;
  expect(scanned.value.format).toBe("hip-bundle");
  expect(scanned.value.coverage.discovery).toBe("complete");

  // Full-file SHA-256 digest streams independently of max_object_bytes instead of issuing 1-byte reads.
  const largePtx = Buffer.concat([
    Buffer.from(ptxFixture),
    Buffer.from("\n//" + "z".repeat(32 * 1024)),
  ]);
  const refused = await inspect(largePtx, {
    analysis: "kernels",
    max_object_bytes: 1,
  });
  if (refused.ok) throw new Error("Expected max_object_bytes refusal");
  expect(projectAnalysisError(refused.error)).toMatchObject({
    code: "resource_constraint",
    details: {
      limit: {
        parameter: "max_object_bytes",
        effective_value: 1,
      },
      refusal: {
        kind: "adjustable_budget",
        control: "max_object_bytes",
      },
    },
  });
});

it("keeps PTX single-parameter 128-token ceiling fixed independently of max_parser_entries", async () => {
  const manyDimensions = "[1]".repeat(45);
  const widePtx = Buffer.from(
    `.version 8.8\n.target sm_80\n.address_size 64\n.visible .entry wide_param(.param .u32 p${manyDimensions}) {\nret;\n}\n`,
  );
  const defaultRefused = await inspect(widePtx, {
    analysis: "kernels",
  });
  if (!defaultRefused.ok) throw defaultRefused.error;
  expect(defaultRefused.value.objects[0]).toMatchObject({
    inspection: "capacity",
    limitations: expect.arrayContaining([
      "PTX parameter declaration exceeds the fixed 128-token syntax limit",
    ]),
  });
  expect(
    defaultRefused.value.objects[0]?.limitations.some((l) =>
      l.includes("(parameter: max_parser_entries)"),
    ),
  ).toBe(false);

  // PTX 1.3 body .param declarations keep the same fixed 128-token limit under defaults.
  const wideBodyParamPtx = Buffer.from(
    `.version 1.3\n.target sm_10\n.entry wide_body() {\n.param .u32 p${manyDimensions};\nret;\n}\n`,
  );
  const bodyRefused = await inspect(wideBodyParamPtx, {
    analysis: "kernels",
  });
  if (!bodyRefused.ok) throw bodyRefused.error;
  expect(bodyRefused.value.objects[0]).toMatchObject({
    inspection: "capacity",
    limitations: expect.arrayContaining([
      "PTX parameter declaration exceeds the fixed 128-token syntax limit",
    ]),
  });
  expect(
    bodyRefused.value.objects[0]?.limitations.some((l) =>
      l.includes("(parameter: max_parser_entries)"),
    ),
  ).toBe(false);

  // Lowering max_parser_entries below 128 does not reject a single normal parameter declaration.
  const singleParamPtx = Buffer.from(
    ".version 8.8\n.target sm_80\n.address_size 64\n.visible .entry add_one(.param .align 8 .u32 x[4]) {\nret;\n}\n",
  );
  const singleParam = await inspect(singleParamPtx, {
    analysis: "kernels",
    max_parser_entries: 4,
  });
  if (!singleParam.ok) throw singleParam.error;
  expect(singleParam.value.objects[0]?.inspection).toBe("complete");
  expect(singleParam.value.kernels.map((k) => k.name)).toEqual(["add_one"]);
});

it("keeps corrupt CCOB v1 recovery distinct from max_object_bytes window truncation", async () => {
  // Corrupt CCOB v1 bytes inside a container larger than max_object_bytes must stay
  // malformed and still recover a later valid CCOB v2 sibling.
  const smallBundle = hipFixture(Buffer.from("x"), "host-x86_64");
  const corruptV1 = Buffer.from(ccobFixture(1, "zlib", smallBundle));
  corruptV1.fill(0xff, 20);
  const siblingV2 = ccobFixture(2, "zlib", smallBundle);
  const combined = Buffer.concat([corruptV1, siblingV2, Buffer.alloc(600)]);
  const recovered = await inspect(combined, {
    analysis: "inventory",
    max_object_bytes: 512,
  });
  if (!recovered.ok) throw recovered.error;
  const bundles = recovered.value.objects.filter(
    (o) => o.kind === "hip-bundle",
  );
  expect(bundles.map((b) => b.inspection)).toEqual(["malformed", "complete"]);
  expect(recovered.value.objects.length).toBe(4);

  // A valid CCOB v1 stream whose compressed extent exceeds max_object_bytes
  // while its declared decoded size fits triggers Z_BUF_ERROR -> capacity (max_object_bytes)
  // and recovers once raised.
  const storedCompressed = deflateSync(smallBundle, { level: 0 });
  const header = Buffer.from(
    ccobFixture(1, "zlib", smallBundle).subarray(0, 20),
  );
  const validV1 = Buffer.concat([header, storedCompressed]);
  expect(storedCompressed.length).toBeGreaterThan(smallBundle.length);
  const truncatedByBudget = await inspect(validV1, {
    analysis: "inventory",
    max_object_bytes: smallBundle.length,
  });
  if (!truncatedByBudget.ok) throw truncatedByBudget.error;
  expect(truncatedByBudget.value.objects[0]).toMatchObject({
    kind: "hip-bundle",
    inspection: "capacity",
    limitations: expect.arrayContaining([
      expect.stringContaining(
        `Legacy CCOB v1 compressed payload exceeds the ${String(smallBundle.length)}-byte object budget (parameter: max_object_bytes)`,
      ),
    ]),
  });
  const raisedV1 = await inspect(validV1, {
    analysis: "inventory",
    max_object_bytes: validV1.length + 64,
  });
  if (!raisedV1.ok) throw raisedV1.error;
  expect(raisedV1.value.objects[0]?.inspection).toBe("complete");

  // Multi-frame Zstandard CCOB v1 whose declared decoded size fits every cut
  // budget (so #budgetWork admits it and execution reaches inputExhausted):
  // cutting at the exact frame boundary or inside the next frame's 4-byte magic
  // must report ccobWindowLimit() capacity instead of publishing a short extent
  // as malformed corruption, and must refill a cached legacy window cleanly.
  const splitAt = Math.floor(smallBundle.length / 2);
  const prefixChunkFrames: Buffer[] = [];
  for (let offset = 0; offset < splitAt; offset += 4) {
    prefixChunkFrames.push(
      zstdCompressSync(
        smallBundle.subarray(offset, Math.min(splitAt, offset + 4)),
      ),
    );
  }
  const prefixFrames = Buffer.concat(prefixChunkFrames);
  const finalFrame = zstdCompressSync(smallBundle.subarray(splitAt));
  const multiFrames = Buffer.concat([prefixFrames, finalFrame]);
  expect(prefixFrames.length).toBeGreaterThanOrEqual(smallBundle.length);
  const zstdHeader = Buffer.from(
    ccobFixture(1, "zstd", smallBundle).subarray(0, 20),
  );
  const multiFrameV1 = Buffer.concat([zstdHeader, multiFrames]);
  for (const extra of [0, 1, 2, 3]) {
    const budget = prefixFrames.length + extra;
    expect(smallBundle.length).toBeLessThanOrEqual(budget);
    expect(budget).toBeLessThan(multiFrames.length);
    const cut = await inspect(multiFrameV1, {
      analysis: "inventory",
      max_object_bytes: budget,
    });
    if (!cut.ok) throw cut.error;
    expect(cut.value.objects).toHaveLength(1);
    expect(cut.value.objects[0]).toMatchObject({
      kind: "hip-bundle",
      inspection: "capacity",
      limitations: expect.arrayContaining([
        expect.stringContaining(
          `Legacy CCOB v1 compressed payload exceeds the ${String(budget)}-byte object budget (parameter: max_object_bytes)`,
        ),
      ]),
    });
  }
  const fullMultiFrame = await inspect(multiFrameV1, {
    analysis: "inventory",
    max_object_bytes: multiFrames.length + 64,
  });
  if (!fullMultiFrame.ok) throw fullMultiFrame.error;
  expect(fullMultiFrame.value.objects[0]?.inspection).toBe("complete");

  // When a sibling's cached legacy window ends right between prefixFrames and
  // finalFrame while max_object_bytes admits the full sibling, refill succeeds.
  const prefixBundle = hipFixture(
    Buffer.from("p".repeat(smallBundle.length)),
    "host-x86_64",
  );
  const prefixStored = deflateSync(prefixBundle, { level: 0 });
  const prefixHeader = Buffer.from(
    ccobFixture(1, "zlib", prefixBundle).subarray(0, 20),
  );
  const prefixV1 = Buffer.concat([prefixHeader, prefixStored]);
  const cachedWindowCut = prefixStored.length + 20 + prefixFrames.length;
  expect(cachedWindowCut).toBeGreaterThanOrEqual(smallBundle.length);
  expect(cachedWindowCut).toBeGreaterThanOrEqual(multiFrames.length);
  const twoSiblings = Buffer.concat([prefixV1, multiFrameV1]);
  const refilledSiblings = await inspect(twoSiblings, {
    analysis: "inventory",
    max_object_bytes: cachedWindowCut,
  });
  if (!refilledSiblings.ok) throw refilledSiblings.error;
  expect(
    refilledSiblings.value.objects
      .filter((o) => o.kind === "hip-bundle")
      .map((o) => o.inspection),
  ).toEqual(["complete", "complete"]);

  // Trailing zero-output Zstandard frames (skippable frame and empty Zstd frame)
  // after a complete data frame: cutting a budget or cached window at the frame
  // boundary (+0), inside the tail magic (+1..+3), in the tail header, or in the
  // tail body must refill when max_object_bytes admits the full stream or report
  // ccobWindowLimit() capacity instead of publishing a short extent.
  const skippablePayload = Buffer.from("skip-tail-payload");
  const skippableTail = Buffer.alloc(8 + skippablePayload.length);
  skippableTail.writeUInt32LE(0x184d2a50, 0);
  skippableTail.writeUInt32LE(skippablePayload.length, 4);
  skippablePayload.copy(skippableTail, 8);
  const emptyZstdTail = zstdCompressSync(Buffer.alloc(0));
  expect(emptyZstdTail.length).toBeGreaterThanOrEqual(8);

  const zeroOutputCases = [
    {
      name: "skippable",
      tail: skippableTail,
      cuts: [0, 1, 2, 3, 6, 10],
    },
    {
      name: "empty-zstd",
      tail: emptyZstdTail,
      cuts: [0, 1, 2, 3, 5, emptyZstdTail.length - 1],
    },
  ] as const;

  for (const { tail, cuts } of zeroOutputCases) {
    const withTailEncoded = Buffer.concat([multiFrames, tail]);
    const withTailV1 = Buffer.concat([zstdHeader, withTailEncoded]);
    const siblingWithTail = Buffer.concat([prefixV1, withTailV1]);
    for (const extra of cuts) {
      // Budget cuts off the trailing zero-output frame: decoded === smallBundle.length
      // already matches the declaration, yet capacity must be reported without a short extent.
      const cutBudget = multiFrames.length + extra;
      expect(smallBundle.length).toBeLessThanOrEqual(cutBudget);
      expect(cutBudget).toBeLessThan(withTailEncoded.length);
      const cutTail = await inspect(withTailV1, {
        analysis: "inventory",
        max_object_bytes: cutBudget,
      });
      if (!cutTail.ok) throw cutTail.error;
      expect(cutTail.value.objects).toHaveLength(1);
      expect(cutTail.value.objects[0]).toMatchObject({
        kind: "hip-bundle",
        inspection: "capacity",
        limitations: expect.arrayContaining([
          expect.stringContaining(
            `Legacy CCOB v1 compressed payload exceeds the ${String(cutBudget)}-byte object budget (parameter: max_object_bytes)`,
          ),
        ]),
      });

      // Cached window from sibling 1 ends inside sibling 2's trailing zero-output frame
      // while max_object_bytes admits sibling 2 completely: refill must succeed cleanly.
      const refillBudget =
        prefixStored.length + 20 + multiFrames.length + extra;
      expect(refillBudget).toBeGreaterThanOrEqual(withTailEncoded.length);
      const refilledTail = await inspect(siblingWithTail, {
        analysis: "inventory",
        max_object_bytes: refillBudget,
      });
      if (!refilledTail.ok) throw refilledTail.error;
      const tailBundles = refilledTail.value.objects.filter(
        (o) => o.kind === "hip-bundle",
      );
      expect(tailBundles.map((b) => b.inspection)).toEqual([
        "complete",
        "complete",
      ]);
      expect(tailBundles[1]?.encoded_size).toBe(withTailEncoded.length);
    }
  }

  // Exact-fit single-frame Zstd CCOB v1 followed by non-frame containers (CCOB v2,
  // NUL padding, or __CLANG_OFFLOAD_BUNDLE__ whose leading '_' = 0x5f overlaps
  // skippable magic's first byte) must not be falsely refused or trigger redundant
  // work-budget-charging refills.
  const exactFrame = zstdCompressSync(smallBundle);
  const exactZstdV1 = Buffer.concat([zstdHeader, exactFrame]);
  const trailingClangBundle = hipFixture(Buffer.from("next"), "host-x86_64");
  const exactWithNul = await inspect(
    Buffer.concat([exactZstdV1, Buffer.alloc(4)]),
    {
      analysis: "inventory",
      max_object_bytes: Math.max(smallBundle.length, exactFrame.length),
    },
  );
  if (!exactWithNul.ok) throw exactWithNul.error;
  expect(exactWithNul.value.coverage.discovery).toBe("complete");
  expect(exactWithNul.value.objects[0]?.inspection).toBe("complete");

  const exactWithClang = await inspect(
    Buffer.concat([exactZstdV1, trailingClangBundle]),
    {
      analysis: "inventory",
      max_object_bytes: Math.max(smallBundle.length, exactFrame.length + 1),
    },
  );
  if (!exactWithClang.ok) throw exactWithClang.error;
  expect(exactWithClang.value.coverage.discovery).toBe("complete");
  expect(
    exactWithClang.value.objects.every((o) => o.inspection === "complete"),
  ).toBe(true);

  // Cached sibling window ending right at a complete Zstd sibling or 1 byte into
  // the following __CLANG_OFFLOAD_BUNDLE__ ('_') must not refill and double-charge
  // max_work_bytes under a tight work budget.
  const tightThree = Buffer.concat([
    prefixV1,
    exactZstdV1,
    trailingClangBundle,
  ]);
  for (const extra of [0, 1]) {
    const windowBudget = prefixStored.length + 20 + exactFrame.length + extra;
    const tightWorkBudget =
      windowBudget + prefixBundle.length + smallBundle.length;
    const tightResult = await inspect(tightThree, {
      analysis: "inventory",
      max_object_bytes: windowBudget,
      max_work_bytes: tightWorkBudget,
    });
    if (!tightResult.ok) throw tightResult.error;
    expect(tightResult.value.coverage.discovery).toBe("complete");
    expect(
      tightResult.value.objects.every((o) => o.inspection === "complete"),
    ).toBe(true);
  }

  // Aliased targetless AMDGPU entries in a Clang offload bundle must charge
  // their native section-table structure reads against max_work_bytes.
  const amdElf = elfFixture(
    224,
    Array.from({ length: 32 }, (_, index) => ({
      name: `.s${String(index)}`,
      type: 1,
      bytes: Buffer.alloc(0),
    })),
  );
  const aliasedCount = 40;
  const aliasedId = Buffer.from("hipv4-amdgcn-amd-amdhsa--");
  const aliasedEntrySize = 8 + 8 + 8 + aliasedId.length;
  const aliasedHeaderLen = 24 + 8 + aliasedCount * aliasedEntrySize;
  const aliasedBundle = Buffer.alloc(aliasedHeaderLen + amdElf.length);
  Buffer.from("__CLANG_OFFLOAD_BUNDLE__").copy(aliasedBundle, 0);
  aliasedBundle.writeBigUInt64LE(BigInt(aliasedCount), 24);
  for (let i = 0; i < aliasedCount; i += 1) {
    const at = 32 + i * aliasedEntrySize;
    aliasedBundle.writeBigUInt64LE(BigInt(aliasedHeaderLen), at);
    aliasedBundle.writeBigUInt64LE(BigInt(amdElf.length), at + 8);
    aliasedBundle.writeBigUInt64LE(BigInt(aliasedId.length), at + 16);
    aliasedId.copy(aliasedBundle, at + 24);
  }
  amdElf.copy(aliasedBundle, aliasedHeaderLen);

  const amdWorkRefused = await inspect(aliasedBundle, {
    analysis: "inventory",
    max_work_bytes: 16_384,
  });
  if (!amdWorkRefused.ok) throw amdWorkRefused.error;
  expect(
    amdWorkRefused.value.objects.some(
      (o) =>
        o.inspection === "capacity" &&
        o.limitations.some((l) => l.includes("(parameter: max_work_bytes)")),
    ),
  ).toBe(true);
  const amdWorkRaised = await inspect(aliasedBundle, {
    analysis: "inventory",
    max_work_bytes: 512 * 1024,
  });
  if (!amdWorkRaised.ok) throw amdWorkRaised.error;
  expect(
    amdWorkRaised.value.objects.some((o) => o.inspection === "capacity"),
  ).toBe(false);

  // max_work_bytes stays capped at main's 512 MiB heap ceiling.
  const overWorkMax = inspectGpuCodeObjectsInputSchema.safeParse({
    path: "/tmp/sample.ptx",
    analysis: "inventory",
    max_work_bytes: 512 * 1024 * 1024 + 1,
  });
  expect(overWorkMax.success).toBe(false);
  const atWorkMax = inspectGpuCodeObjectsInputSchema.safeParse({
    path: "/tmp/sample.ptx",
    analysis: "inventory",
    max_work_bytes: 512 * 1024 * 1024,
  });
  expect(atWorkMax.success).toBe(true);
});

it("does not double-charge work on CCOB v1 refill, bounds aliased sections, keeps non-GPU inputs unsupported, and aligns zstd.max_frames and recovery bounds", async () => {
  // 1. Cached CCOB v1 refill charges declaredDecodedSize once, not twice.
  const b1 = hipFixture(Buffer.alloc(200, 0x31), "host-x86_64");
  const c1 = deflateSync(b1, { level: 0 });
  const h1 = Buffer.from(ccobFixture(1, "zlib", b1).subarray(0, 20));
  const v1First = Buffer.concat([h1, c1]);

  const b2 = hipFixture(Buffer.alloc(120, 0x41), "host-x86_64");
  const f2a = zstdCompressSync(b2.subarray(0, 60));
  const f2b = zstdCompressSync(b2.subarray(60));
  const c2 = Buffer.concat([f2a, f2b]);
  const h2 = Buffer.from(ccobFixture(1, "zstd", b2).subarray(0, 20));
  const v1Second = Buffer.concat([h2, c2]);
  const refillPair = Buffer.concat([v1First, v1Second]);
  const refillObjBudget = c1.length + 20 + f2a.length;
  expect(refillObjBudget).toBeGreaterThanOrEqual(b2.length);
  expect(refillObjBudget).toBeGreaterThanOrEqual(c2.length);
  const exactWorkOnce = refillObjBudget + b1.length + b2.length + c2.length;
  const refillOnce = await inspect(refillPair, {
    analysis: "inventory",
    max_object_bytes: refillObjBudget,
    max_work_bytes: exactWorkOnce,
  });
  if (!refillOnce.ok) throw refillOnce.error;
  expect(
    refillOnce.value.objects
      .filter((o) => o.kind === "hip-bundle")
      .map((o) => o.inspection),
  ).toEqual(["complete", "complete"]);

  // 2. Second hasFollowingZstandardFrame check after refill prevents false capacity
  // when cached window ends on sibling 2's exact frame boundary (triggering the
  // inputExhausted refill path), refill completes sibling 2 at max_object_bytes,
  // and 16 NUL bytes follow.
  const small1 = hipFixture(Buffer.from("x"), "host-x86_64");
  const stored1 = deflateSync(small1, { level: 0 });
  const stored1V1 = Buffer.concat([
    Buffer.from(ccobFixture(1, "zlib", small1).subarray(0, 20)),
    stored1,
  ]);
  const small2 = hipFixture(Buffer.from("x"), "host-x86_64");
  const manySmallFrames: Buffer[] = [];
  for (let off = 0; off < small2.length; off += 2) {
    manySmallFrames.push(
      zstdCompressSync(small2.subarray(off, Math.min(small2.length, off + 2))),
    );
  }
  const manyEncoded = Buffer.concat(manySmallFrames);
  const manyV1 = Buffer.concat([
    Buffer.from(ccobFixture(1, "zstd", small2).subarray(0, 20)),
    manyEncoded,
  ]);
  // Align sibling 2 so window 1 (length === manyEncoded.length, starting at offset 20)
  // ends on the exact boundary of sibling 2's first frame (available === firstFrameLen).
  const firstFrameLen = manySmallFrames[0]!.length;
  const alignPad = manyEncoded.length - stored1V1.length - firstFrameLen;
  expect(alignPad).toBeGreaterThan(0);
  const refillThenNul = Buffer.concat([
    stored1V1,
    Buffer.alloc(alignPad),
    manyV1,
    Buffer.alloc(16),
  ]);
  const afterRefillNul = await inspect(refillThenNul, {
    analysis: "inventory",
    max_object_bytes: manyEncoded.length,
  });
  if (!afterRefillNul.ok) throw afterRefillNul.error;
  const refillNulBundles = afterRefillNul.value.objects.filter(
    (o) => o.kind === "hip-bundle",
  );
  expect(refillNulBundles.map((o) => o.inspection)).toEqual([
    "complete",
    "complete",
  ]);
  expect(refillNulBundles[1]?.encoded_size).toBe(manyEncoded.length);

  // 3. 40 aliased .hip_fatbin sections pointing to a 3,860-byte PTX payload (all
  // bytes read via sectionSource recognition) must yield exactly 4 complete and
  // 36 capacity sections under max_work_bytes: 16_384.
  const ptxHeader = ".version 8.8\n.target sm_80\n// ";
  const ptxFooter = "\n.visible .entry k() { ret; }\n";
  const aliasedPtx = Buffer.from(
    `${ptxHeader}${"x".repeat(3860 - ptxHeader.length - ptxFooter.length)}${ptxFooter}`,
  );
  expect(aliasedPtx.length).toBe(3860);
  const secCount = 40;
  const totalSections = 2 + secCount;
  const shstrtab = Buffer.from("\0.shstrtab\0.hip_fatbin\0");
  const payloadOff = 64;
  const strOff = Math.ceil((payloadOff + aliasedPtx.length) / 8) * 8;
  const shoff = Math.ceil((strOff + shstrtab.length) / 8) * 8;
  const aliasedSectionElf = Buffer.alloc(shoff + totalSections * 64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]).copy(aliasedSectionElf, 0);
  aliasedSectionElf.writeUInt16LE(2, 16);
  aliasedSectionElf.writeUInt16LE(62, 18);
  aliasedSectionElf.writeUInt32LE(1, 20);
  aliasedSectionElf.writeBigUInt64LE(BigInt(shoff), 40);
  aliasedSectionElf.writeUInt16LE(64, 52);
  aliasedSectionElf.writeUInt16LE(64, 58);
  aliasedSectionElf.writeUInt16LE(totalSections, 60);
  aliasedSectionElf.writeUInt16LE(1, 62);
  aliasedPtx.copy(aliasedSectionElf, payloadOff);
  shstrtab.copy(aliasedSectionElf, strOff);
  const s1 = shoff + 64;
  aliasedSectionElf.writeUInt32LE(1, s1);
  aliasedSectionElf.writeUInt32LE(3, s1 + 4);
  aliasedSectionElf.writeBigUInt64LE(BigInt(strOff), s1 + 24);
  aliasedSectionElf.writeBigUInt64LE(BigInt(shstrtab.length), s1 + 32);
  for (let i = 0; i < secCount; i += 1) {
    const sh = shoff + (2 + i) * 64;
    aliasedSectionElf.writeUInt32LE(11, sh);
    aliasedSectionElf.writeUInt32LE(1, sh + 4);
    aliasedSectionElf.writeBigUInt64LE(BigInt(payloadOff), sh + 24);
    aliasedSectionElf.writeBigUInt64LE(BigInt(aliasedPtx.length), sh + 32);
  }
  const aliasedSectionRefused = await inspect(aliasedSectionElf, {
    analysis: "inventory",
    max_work_bytes: 16_384,
  });
  if (!aliasedSectionRefused.ok) throw aliasedSectionRefused.error;
  const nativeSections = aliasedSectionRefused.value.objects.filter(
    (o) => o.kind === "native-section",
  );
  expect(
    nativeSections.filter((o) => o.inspection === "complete"),
  ).toHaveLength(4);
  const capacitySections = nativeSections.filter(
    (o) =>
      o.inspection === "capacity" &&
      o.limitations.some((l) => l.includes("(parameter: max_work_bytes)")),
  );
  expect(capacitySections).toHaveLength(36);

  // 3b. Single .hip_fatbin section with 6,060-byte PTX:
  // (a) max_work_bytes: 6100 succeeds (no double-charge across recognition + probe read);
  // (b) max_object_bytes: 4096 reports capacity (parameter: max_object_bytes).
  const sectionPtx6060 = Buffer.from(
    `${ptxHeader}${"y".repeat(6060 - ptxHeader.length - ptxFooter.length)}${ptxFooter}`,
  );
  expect(sectionPtx6060.length).toBe(6060);
  const singleSectionPtxElf = elfFixture(62, [
    { name: ".hip_fatbin", type: 1, bytes: sectionPtx6060 },
  ]);
  const singleSectionWorkOk = await inspect(singleSectionPtxElf, {
    analysis: "inventory",
    max_work_bytes: 6100,
  });
  if (!singleSectionWorkOk.ok) throw singleSectionWorkOk.error;
  expect(
    singleSectionWorkOk.value.objects.every(
      (o) => o.inspection === "complete" || o.inspection === "inventory",
    ),
  ).toBe(true);
  expect(
    singleSectionWorkOk.value.objects.find((o) => o.kind === "native-section")
      ?.inspection,
  ).toBe("complete");

  const singleSectionObjRefused = await inspect(singleSectionPtxElf, {
    analysis: "inventory",
    max_object_bytes: 4096,
  });
  if (!singleSectionObjRefused.ok) throw singleSectionObjRefused.error;
  expect(
    singleSectionObjRefused.value.objects.find(
      (o) => o.kind === "native-section",
    ),
  ).toMatchObject({
    inspection: "capacity",
    limitations: expect.arrayContaining([
      expect.stringContaining("(parameter: max_object_bytes)"),
    ]),
  });

  // 3c. Metered #reserveReadWork, nested sectionSource !parentMetered, and
  // #amdPayload child !parentMetered must each charge work once, not twice.
  const ccobInnerPayload = hipFixture(Buffer.alloc(2000, 0x41), "host-x86_64");
  const ccobStoredV2 = ccobFixture(2, "zlib", ccobInnerPayload);
  const ccobInSectionElf = elfFixture(62, [
    { name: ".hip_fatbin", type: 1, bytes: ccobStoredV2 },
  ]);
  const ccobExactWork = 32 + 32 + ccobStoredV2.length + ccobInnerPayload.length;
  const ccobSectionOk = await inspect(ccobInSectionElf, {
    analysis: "inventory",
    max_work_bytes: ccobExactWork,
  });
  if (!ccobSectionOk.ok) throw ccobSectionOk.error;
  expect(
    ccobSectionOk.value.objects.find((o) => o.kind === "hip-bundle")
      ?.inspection,
  ).toBe("complete");

  const nestedPtx = Buffer.from(
    `${ptxHeader}${"n".repeat(2000 - ptxHeader.length - ptxFooter.length)}${ptxFooter}`,
  );
  const innerElf = elfFixture(62, [
    { name: ".hip_fatbin", type: 1, bytes: nestedPtx },
  ]);
  const outerElf = elfFixture(62, [
    { name: ".hip_fatbin", type: 1, bytes: innerElf },
  ]);
  const nestedExactWork = innerElf.length + 256;
  const nestedSectionOk = await inspect(outerElf, {
    analysis: "inventory",
    max_work_bytes: nestedExactWork,
  });
  if (!nestedSectionOk.ok) throw nestedSectionOk.error;
  expect(
    nestedSectionOk.value.objects
      .filter((o) => o.kind === "native-section")
      .every((o) => o.inspection === "complete"),
  ).toBe(true);

  const nestedAmdElf = elfFixture(
    224,
    Array.from({ length: 48 }, (_, index) => ({
      name: `.s${String(index)}`,
      type: 1,
      bytes: Buffer.alloc(0),
    })),
  );
  const nestedAmdBundle = hipFixture(nestedAmdElf, "hipv4-amdgcn-amd-amdhsa--");
  const nestedAmdSectionElf = elfFixture(62, [
    { name: ".hip_fatbin", type: 1, bytes: nestedAmdBundle },
  ]);
  const nestedAmdWork = nestedAmdElf.length + 512;
  const nestedAmdOk = await inspect(nestedAmdSectionElf, {
    analysis: "inventory",
    max_work_bytes: nestedAmdWork,
  });
  if (!nestedAmdOk.ok) throw nestedAmdOk.error;
  expect(
    nestedAmdOk.value.objects.some((o) => o.inspection === "capacity"),
  ).toBe(false);

  // 4. Non-GPU plain text must fail with unsupported_target rather than being
  // preempted by lowered max_object_bytes or max_token_bytes.
  const plainLong = Buffer.from("hello world ".repeat(100)); // 1200 bytes
  for (const budget of [512, 1]) {
    const nonGpuObj = await inspect(plainLong, {
      analysis: "inventory",
      max_object_bytes: budget,
    });
    expect(nonGpuObj.ok).toBe(false);
    if (nonGpuObj.ok) return;
    expect(projectAnalysisError(nonGpuObj.error)).toMatchObject({
      code: "unsupported_target",
    });
  }
  const plainWord = Buffer.from(
    "this_is_plain_non_gpu_text_with_a_long_identifier_token_123",
  );
  const nonGpuToken = await inspect(plainWord, {
    analysis: "inventory",
    max_token_bytes: 16,
  });
  expect(nonGpuToken.ok).toBe(false);
  if (nonGpuToken.ok) return;
  expect(projectAnalysisError(nonGpuToken.error)).toMatchObject({
    code: "unsupported_target",
  });

  // Once PTX is recognized, max_token_bytes still applies to the .version header
  // tokens in inventory mode (matching kernels mode) and prevents over-limit
  // zero-padded version literals from bypassing the default token ceiling.
  const ptxHeaderTooSmall = await inspect(
    Buffer.from(".version 8.8\n.target sm_80\n"),
    {
      analysis: "inventory",
      max_token_bytes: 7,
    },
  );
  expect(ptxHeaderTooSmall.ok).toBe(false);
  if (ptxHeaderTooSmall.ok) return;
  expect(projectAnalysisError(ptxHeaderTooSmall.error)).toMatchObject({
    code: "resource_constraint",
    details: {
      limit: { parameter: "max_token_bytes", effective_value: 7 },
      refusal: { kind: "adjustable_budget", control: "max_token_bytes" },
    },
  });
  const overDefaultVersionPtx = Buffer.from(
    `.version ${"0".repeat(70_000)}8.0\n.target sm_80\n`,
  );
  const ptxVersionOverDefault = await inspect(overDefaultVersionPtx, {
    analysis: "inventory",
  });
  expect(ptxVersionOverDefault.ok).toBe(false);
  if (ptxVersionOverDefault.ok) return;
  expect(projectAnalysisError(ptxVersionOverDefault.error)).toMatchObject({
    code: "resource_constraint",
    details: {
      limit: { parameter: "max_token_bytes", effective_value: 65_536 },
      refusal: { kind: "adjustable_budget", control: "max_token_bytes" },
    },
  });

  // 5. zstd.max_frames takes precedence over max_object_bytes at +0..+3 when
  // lookahead confirms a following frame past the frame allowance.
  const frameTarget = hipFixture(Buffer.from("x"), "host-x86_64");
  const bigSkipPayload = Buffer.alloc(frameTarget.length + 16);
  const bigSkip = Buffer.alloc(8 + bigSkipPayload.length);
  bigSkip.writeUInt32LE(0x184d2a50, 0);
  bigSkip.writeUInt32LE(bigSkipPayload.length, 4);
  const dataFrame = zstdCompressSync(frameTarget);
  const skipThenDataV1 = Buffer.concat([
    Buffer.from(ccobFixture(1, "zstd", frameTarget).subarray(0, 20)),
    bigSkip,
    dataFrame,
  ]);
  for (const extra of [0, 1, 2, 3, 4]) {
    const res = await runWithAnalysisOperationSnapshot(
      { revision: 1, overrides: { "zstd.max_frames": 1 } },
      () =>
        inspect(skipThenDataV1, {
          analysis: "inventory",
          max_object_bytes: bigSkip.length + extra,
        }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      limit: { setting: "zstd.max_frames", effective_value: 1 },
    });
  }

  // 6. Corrupt CCOB v1 whose total extent equals max_object_bytes still recovers
  // the immediately following valid CCOB v2 marker at offset === max_object_bytes.
  const corruptExact = Buffer.concat([
    Buffer.from(ccobFixture(1, "zlib", small1).subarray(0, 20)),
    Buffer.alloc(180, 0xff),
  ]);
  expect(corruptExact.length).toBe(200);
  const nextValidV2 = ccobFixture(2, "zlib", small1);
  const exactRecovery = await inspect(
    Buffer.concat([corruptExact, nextValidV2]),
    {
      analysis: "inventory",
      max_object_bytes: corruptExact.length,
    },
  );
  if (!exactRecovery.ok) throw exactRecovery.error;
  expect(
    exactRecovery.value.objects
      .filter((o) => o.kind === "hip-bundle")
      .map((o) => o.inspection),
  ).toEqual(["malformed", "complete"]);

  const overRecovery = await inspect(
    Buffer.concat([corruptExact, Buffer.of(0xff), nextValidV2]),
    {
      analysis: "inventory",
      max_object_bytes: corruptExact.length,
    },
  );
  if (!overRecovery.ok) throw overRecovery.error;
  expect(
    overRecovery.value.objects
      .filter((o) => o.kind === "hip-bundle")
      .map((o) => o.inspection),
  ).toEqual(["capacity"]);

  // 7. CudaFatbinary forwards AbortSignal to nextGpuContainerOffset during
  // multi-megabyte NUL padding scans.
  const cudaBase = cudaFixture("none");
  const paddedCuda = Buffer.concat([cudaBase, Buffer.alloc(2 * 1024 * 1024)]);
  const abortController = new AbortController();
  let readsAfterStart = 0;
  const origSource = new GpuInventory(
    { path: "/padded-cuda", analysis: "inventory" },
    abortController.signal,
  );
  await expect(
    origSource.inspect({
      size: paddedCuda.length,
      containerId: null,
      read: async (offset, size) => paddedCuda.subarray(offset, offset + size),
      readBounded: async (offset, size) => {
        if (offset >= cudaBase.length && ++readsAfterStart === 17)
          abortController.abort(
            new Error("cancelled during cuda padding scan"),
          );
        return paddedCuda.subarray(offset, offset + size);
      },
    }),
  ).rejects.toThrow();
});

it("applies max_structure_bytes independently of max_object_bytes and covers PE, CUBIN, and report baseline", async () => {
  // ELF section table (8 sections = 512 bytes) succeeds when max_structure_bytes admits it
  // even if max_object_bytes is smaller (256 bytes).
  const emptyElf = elfFixture(
    62,
    Array.from({ length: 6 }, (_, i) => ({
      name: `.s${String(i)}`,
      type: 1,
      bytes: Buffer.alloc(8),
    })),
  );
  const elfOk = await inspect(emptyElf, {
    analysis: "inventory",
    max_object_bytes: 256,
    max_structure_bytes: 65_536,
  });
  if (!elfOk.ok) throw elfOk.error;
  expect(elfOk.value.format).toBe("elf");
  expect(elfOk.value.coverage.discovery).toBe("complete");

  // Baseline report reservation is enforced even when no GPU sections are present.
  // Because this is a lower bound before later facts are retained, details.limit
  // omits required_value and details.reported_limits records minimum_report_bytes.
  const baselineRefused = await inspect(emptyElf, {
    analysis: "inventory",
    max_report_bytes: 500,
  });
  if (baselineRefused.ok)
    throw new Error("Expected baseline max_report_bytes refusal");
  const baselineProjected = projectAnalysisError(baselineRefused.error);
  expect(baselineProjected).toMatchObject({
    code: "resource_constraint",
    details: {
      limit: { parameter: "max_report_bytes", effective_value: 500 },
      refusal: { kind: "adjustable_budget", control: "max_report_bytes" },
    },
  });
  const baselineDetails = baselineProjected.details as {
    limit?: { required_value?: number };
    reported_limits?: { minimum_report_bytes?: number };
  };
  expect(baselineDetails.limit?.required_value).toBeUndefined();
  const minimumBaseline = baselineDetails.reported_limits?.minimum_report_bytes;
  expect(minimumBaseline).toBeTypeOf("number");
  expect(minimumBaseline!).toBeGreaterThan(500);
  const baselineRecovered = await inspect(emptyElf, {
    analysis: "inventory",
    max_report_bytes: minimumBaseline!,
  });
  expect(baselineRecovered.ok).toBe(true);

  // PE section directory enforces max_structure_bytes and recovers when raised.
  const peBytes = peGpuFixture();
  const peRefused = await inspect(peBytes, {
    analysis: "inventory",
    max_structure_bytes: 64,
  });
  if (peRefused.ok) throw new Error("Expected PE max_structure_bytes refusal");
  expect(projectAnalysisError(peRefused.error)).toMatchObject({
    code: "resource_constraint",
    details: {
      limit: { parameter: "max_structure_bytes", effective_value: 64 },
      refusal: { kind: "adjustable_budget", control: "max_structure_bytes" },
    },
  });
  const peRecovered = await inspect(peBytes, {
    analysis: "inventory",
    max_structure_bytes: 65_536,
  });
  expect(peRecovered.ok).toBe(true);

  // CUBIN CudaMetadataBudget respects max_parser_visits and recovers when raised.
  const cubinBytes = cubinFixture();
  const cubinLimited = await inspect(cubinBytes, {
    analysis: "kernels",
    max_parser_visits: 1,
  });
  if (!cubinLimited.ok) throw cubinLimited.error;
  expect(cubinLimited.value.objects[0]).toMatchObject({
    inspection: "capacity",
    limitations: expect.arrayContaining([
      expect.stringContaining("(parameter: max_parser_visits)"),
    ]),
  });
  const cubinRecovered = await inspect(cubinBytes, {
    analysis: "kernels",
    max_parser_visits: 4096,
  });
  if (!cubinRecovered.ok) throw cubinRecovered.error;
  expect(cubinRecovered.value.objects[0]?.inspection).toBe("complete");
});
