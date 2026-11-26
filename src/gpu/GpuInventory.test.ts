import { expect, it } from "vitest";
import { GpuInventory } from "./GpuInventory.js";
import { GpuBufferSource } from "./GpuSource.js";
import { assertArtifactReadActive } from "../resources/ArtifactFileOperation.js";
import {
  ccobFixture,
  cubinFixture,
  cudaFixture,
  elfFixture,
} from "../../tests/fixtures/gpu/codeObjects.js";

it.each(["cuda", "ccob", "ccob-v1"] as const)(
  "refuses oversized %s output before reading compressed input",
  async (kind) => {
    const bytes =
      kind === "cuda"
        ? cudaFixture("zstd", [{ kind: 2, target: 80, bytes: cubinFixture() }])
        : kind === "ccob"
          ? ccobFixture(3)
          : Buffer.concat([ccobFixture(1), ccobFixture(2)]);
    const payloadOffset = kind === "cuda" ? 80 : kind === "ccob" ? 32 : 20;
    if (kind === "ccob-v1") bytes.writeUInt32LE(128 * 1024 * 1024 + 1, 8);
    else
      bytes.writeBigUInt64LE(
        BigInt(128 * 1024 * 1024 + 1),
        kind === "cuda" ? 72 : 16,
      );
    const source = new GpuBufferSource(bytes, "fixture"),
      reads: number[] = [],
      inventory = new GpuInventory({ path: "/fixture", analysis: "kernels" });
    await inventory.inspect({
      size: source.size,
      containerId: source.containerId,
      read: async (offset, size) => {
        reads.push(offset);
        return source.read(offset, size);
      },
    });
    expect(reads).not.toContain(payloadOffset);
    expect(inventory.objects[0]).toMatchObject({
      inspection: "capacity",
      sha256: null,
    });
    expect(inventory.kernels).toEqual([]);
    if (kind === "ccob-v1") {
      expect(inventory.objects).toHaveLength(1);
      expect(inventory.objects[0]!.location.size).toBe(bytes.length - 20);
      expect(inventory.objects[0]!.limitations.join(" ")).toContain(
        "only the containing tail",
      );
      expect(inventory.objects[0]!.limitations.join(" ")).toContain(
        "Later siblings were not inferred",
      );
    }
  },
);
it.each(["zlib", "zstd"] as const)(
  "omits an unfinished v1 %s extent when cancellation interrupts its source read",
  async (codec) => {
    const first = ccobFixture(2, codec),
      second = ccobFixture(1, codec),
      source = new GpuBufferSource(Buffer.concat([first, second]), "fixture"),
      controller = new AbortController(),
      reason = { selected: "cancel-v1-payload-read" },
      inventory = new GpuInventory(
        { path: "/fixture", analysis: "inventory" },
        controller.signal,
      );
    let interrupted = false;
    const result = inventory.inspect({
      size: source.size,
      containerId: source.containerId,
      read: async (offset, size) => {
        if (offset === first.length + 20) {
          interrupted = true;
          controller.abort(reason);
          assertArtifactReadActive(controller.signal);
        }
        return source.read(offset, size);
      },
    });
    await expect(result).rejects.toMatchObject({
      reason: "cancelled",
      cause: reason,
    });
    expect(interrupted).toBe(true);
    const wrappers = inventory.objects.filter(
      ({ kind }) => kind === "hip-bundle",
    );
    expect(wrappers).toHaveLength(1);
    expect(wrappers[0]).toMatchObject({
      id: "fixture@0",
      inspection: "complete",
      encoded_size: first.length - 24,
      location: { offset: 24, size: first.length - 24 },
    });
    expect(
      inventory.objects.every(
        ({ id, parent_id }) =>
          id !== `fixture@${first.length.toString(16)}` &&
          parent_id !== `fixture@${first.length.toString(16)}`,
      ),
    ).toBe(true);
  },
);
it("observes cancellation while walking flat empty bundles in a decoded buffer", async () => {
  const empty = Buffer.alloc(32);
  empty.write("__CLANG_OFFLOAD_BUNDLE__");
  const bytes = Buffer.concat(Array.from({ length: 4096 }, () => empty));
  const controller = new AbortController(),
    reason = { selected: "cancel-buffer-walk" };
  const inventory = new GpuInventory(
    { path: "/fixture", analysis: "inventory" },
    controller.signal,
  );
  const result = inventory.inspect(new GpuBufferSource(bytes, "fixture"));
  setImmediate(() => controller.abort(reason));
  await expect(result).rejects.toMatchObject({
    reason: "cancelled",
    cause: reason,
  });
});
it.each(["zlib", "zstd"] as const)(
  "reuses observed %s input across multiple valid legacy CCOB siblings",
  async (codec) => {
    const count = 16,
      bytes = Buffer.concat(
        Array.from({ length: count }, () => ccobFixture(1, codec)),
      ),
      source = new GpuBufferSource(bytes, "fixture"),
      inventory = new GpuInventory({ path: "/fixture", analysis: "inventory" });
    let observedReadBytes = 0;
    await inventory.inspect({
      size: source.size,
      containerId: source.containerId,
      read: async (offset, size) => {
        observedReadBytes += size;
        return source.read(offset, size);
      },
    });
    const bundles = inventory.objects.filter(
      ({ kind }) => kind === "hip-bundle",
    );
    expect(bundles).toHaveLength(count);
    expect(bundles.every(({ inspection }) => inspection === "complete")).toBe(
      true,
    );
    expect(inventory.discovery).toBe("complete");
    // Includes prefix/alignment reads. Re-reading every suffix grows with the
    // square of the sibling count and exceeds this physical-input allowance.
    expect(observedReadBytes).toBeLessThan(2 * bytes.length);
  },
);

it("classifies an over-limit kernel symbol name as capacity", async () => {
  const bytes = cubinFixture({ name: "x".repeat(65_536) });
  const inventory = new GpuInventory({ path: "/fixture", analysis: "kernels" });
  await inventory.inspect(new GpuBufferSource(bytes, "fixture"));
  expect(inventory.objects[0]).toMatchObject({
    inspection: "capacity",
    limitations: expect.arrayContaining([
      expect.stringContaining("65536-byte read allowance"),
    ]),
  });
});

it.each(["standalone", "embedded"] as const)(
  "retains a valid %s PTX kernel before a malformed entry",
  async (kind) => {
    const ptx = Buffer.from(
      ".version 8.8\n.target sm_80\n.entry good() { ret; }\n.entry broken(",
    );
    const bytes =
      kind === "standalone"
        ? ptx
        : cudaFixture("none", [{ kind: 1, target: 75, bytes: ptx }]);
    const inventory = new GpuInventory({
      path: "/fixture",
      analysis: "kernels",
    });
    await inventory.inspect(new GpuBufferSource(bytes, "fixture"));
    expect(inventory.objects.find(({ kind }) => kind === "ptx")).toMatchObject({
      inspection: "malformed",
      payload_target: "sm_80",
    });
    expect(inventory.kernels.map(({ name }) => name)).toEqual(["good"]);
    if (kind === "embedded")
      expect(inventory.kernels[0]?.limitations).toContain(
        "Conflicting target declarations: inventory sm_75; payload sm_80. Target agreement is not established.",
      );
  },
);

const conflictingCudaCubin = (options: {
  sharedSizes: readonly number[];
  aliasShared?: boolean;
  globalRegisterValues: readonly number[];
  textRegisters?: number;
}): Buffer => {
  const name = "add_one";
  const symbols = Buffer.alloc(48);
  symbols.writeUInt32LE(1, 24);
  symbols[28] = 0x12;
  symbols[29] = 0x10;
  symbols.writeUInt16LE(4, 30);
  symbols.writeBigUInt64LE(16n, 40);
  const global = Buffer.concat(
    options.globalRegisterValues.map((value) => {
      const record = Buffer.from("042f08000100000000000000", "hex");
      record.writeUInt32LE(value, 8);
      return record;
    }),
  );
  const info = Buffer.from(
    "03190c0004170c00000000000100080000f0110004170c00000000000000000000f02100",
    "hex",
  );
  return elfFixture(
    190,
    [
      { name: ".strtab", type: 3, bytes: Buffer.from(`\0${name}\0`) },
      { name: ".symtab", type: 2, link: 2, entrySize: 24, bytes: symbols },
      {
        name: `.text.${name}`,
        flags: 0x100006n,
        info: ((options.textRegisters ?? 0) << 24) | 1,
        bytes: Buffer.alloc(16),
      },
      ...(global.length > 0
        ? [{ name: ".nv.info", type: 0x70000000, link: 3, bytes: global }]
        : []),
      {
        name: `.nv.info.${name}`,
        type: 0x70000000,
        link: 3,
        info: 4,
        bytes: info,
      },
      ...options.sharedSizes.map((size, index) => ({
        name:
          index === 0 || options.aliasShared === true
            ? `.nv.shared.${name}`
            : `.nv.shared.${name}.${index}`,
        type: 8,
        info: 4,
        size,
      })),
    ],
    0x81,
  );
};

it("names an unreadable shared section name instead of returning a bare null count", async () => {
  const bytes = conflictingCudaCubin({
    sharedSizes: [64],
    globalRegisterValues: [10],
  });
  // The shared section is the last one this fixture writes; point its sh_name past the
  // string table so the name cannot be read and a shared section cannot be ruled out.
  const table = Number(bytes.readBigUInt64LE(40));
  const sections = bytes.readUInt16LE(60);
  bytes.writeUInt32LE(0xffff, table + (sections - 1) * 64);
  const inventory = new GpuInventory({ path: "/fixture", analysis: "kernels" });
  await inventory.inspect(new GpuBufferSource(bytes, "fixture"));
  expect(inventory.kernels[0]).toMatchObject({
    shared_bytes: null,
    limitations: expect.arrayContaining([
      "CUDA section names are not all known, so a shared memory section cannot be ruled out; shared byte count remains unknown",
    ]),
  });
});

it("marks conflicting CUDA .nv.shared sections partial with null shared_bytes and provenance", async () => {
  const bytes = conflictingCudaCubin({
    sharedSizes: [64, 128],
    globalRegisterValues: [10],
  });
  const inventory = new GpuInventory({ path: "/fixture", analysis: "kernels" });
  await inventory.inspect(new GpuBufferSource(bytes, "fixture"));
  expect(inventory.objects[0]).toMatchObject({ inspection: "partial" });
  expect(inventory.kernels).toHaveLength(1);
  expect(inventory.kernels[0]).toMatchObject({
    name: "add_one",
    shared_bytes: null,
    sources: { shared: null },
    limitations: expect.arrayContaining([
      "Conflicting CUDA shared memory declarations; shared byte count remains unknown",
    ]),
  });
});

it.each([
  {
    label: "nv.info vs .text section header",
    bytes: cubinFixture({ globalRegisters: 10, textRegisters: 16 }),
  },
  {
    label: "multiple nv.info values alongside .text section header",
    bytes: conflictingCudaCubin({
      sharedSizes: [64],
      globalRegisterValues: [10, 12],
      textRegisters: 16,
    }),
  },
] as const)(
  "clears register provenance when CUDA register declarations conflict ($label)",
  async ({ bytes }) => {
    const inventory = new GpuInventory({
      path: "/fixture",
      analysis: "kernels",
    });
    await inventory.inspect(new GpuBufferSource(bytes, "fixture"));
    expect(inventory.objects[0]).toMatchObject({ inspection: "partial" });
    expect(inventory.kernels).toHaveLength(1);
    expect(inventory.kernels[0]).toMatchObject({
      name: "add_one",
      registers: { physical: null },
      sources: { registers: null },
      limitations: expect.arrayContaining([
        "Conflicting CUDA register declarations; physical count remains unknown",
      ]),
    });
  },
);

it("keeps non-conflicting CUDA register fallbacks, agreeing declarations, and aliased .nv.shared headers complete", async () => {
  // 1. No .nv.info register records: fall back to .text header sh_info >>> 24.
  const textOnly = conflictingCudaCubin({
    sharedSizes: [64],
    globalRegisterValues: [],
    textRegisters: 24,
  });
  const textOnlyInventory = new GpuInventory({
    path: "/fixture",
    analysis: "kernels",
  });
  await textOnlyInventory.inspect(new GpuBufferSource(textOnly, "fixture"));
  expect(textOnlyInventory.objects[0]).toMatchObject({
    inspection: "complete",
  });
  expect(textOnlyInventory.kernels[0]).toMatchObject({
    registers: { physical: 24 },
    sources: { registers: { section_name: ".text.add_one" } },
  });

  // 2. Agreeing .nv.info and .text register declarations remain complete with .nv.info provenance.
  const agreeing = cubinFixture({
    globalRegisters: 16,
    textRegisters: 16,
    shared: 64,
  });
  const agreeingInventory = new GpuInventory({
    path: "/fixture",
    analysis: "kernels",
  });
  await agreeingInventory.inspect(new GpuBufferSource(agreeing, "fixture"));
  expect(agreeingInventory.objects[0]).toMatchObject({
    inspection: "complete",
  });
  expect(agreeingInventory.kernels[0]).toMatchObject({
    registers: { physical: 16 },
    sources: { registers: { section_name: ".nv.info" } },
  });

  // 3. Identical aliased .nv.shared.* section headers deduplicate via seenMetadata.
  const aliasedShared = conflictingCudaCubin({
    sharedSizes: [64, 64],
    aliasShared: true,
    globalRegisterValues: [10],
  });
  const aliasedInventory = new GpuInventory({
    path: "/fixture",
    analysis: "kernels",
  });
  await aliasedInventory.inspect(new GpuBufferSource(aliasedShared, "fixture"));
  expect(aliasedInventory.objects[0]).toMatchObject({
    inspection: "complete",
  });
  expect(aliasedInventory.kernels[0]).toMatchObject({
    shared_bytes: 64,
    sources: { shared: { section_name: ".nv.shared.add_one" } },
  });
});
