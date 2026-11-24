import {
  DEFAULT_BUN_READER_LIMITS,
  type BunReaderLimits,
} from "../../domain/artifactReaderLimits.js";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import {
  CPU_ARM64,
  CPU_X86_64,
  universalMacho,
} from "../../../tests/fixtures/universalMacho.js";
import { probeBunStandaloneGraph } from "./BunModuleGraphLayout.js";
import { decodeBunModuleGraph } from "./BunModuleGraphMembers.js";
import {
  locateBunGraphFixture,
  BUN_FIXTURE_GRAPH_SUFFIX_BYTES,
  bunModuleGraphPayload,
  bunPrefixedPayload,
  machoBunSection,
  machoBunSections,
  peBunSection,
  elfBunSection,
  elfAppendedBunPayload,
  elfPrefix,
} from "./BunStandalone.fixture.js";

async function locate(bytes: Buffer) {
  const path = join(await createTestTempDirectory("rea-bun-parser-"), "app");
  await writeFile(path, bytes);
  const handle = await open(path, "r");
  try {
    const result = await locateBunGraphFixture(handle, bytes.length);
    if (result.status === "present" && result.graph !== undefined) {
      const graph = result.graph;
      return {
        ...result,
        graph: {
          ...graph,
          data: {
            length: graph.data.length,
            read: async (offset: number, length: number) =>
              Buffer.from(
                bytes.subarray(
                  graph.payloadOffset + offset,
                  graph.payloadOffset + offset + length,
                ),
              ),
          },
        },
      };
    }
    return result;
  } finally {
    await handle.close();
  }
}

/** Probe while counting bytes read through the handle. */
async function probe(bytes: Buffer, limits?: BunReaderLimits) {
  const path = join(await createTestTempDirectory("rea-bun-parser-"), "app");
  await writeFile(path, bytes);
  const handle = await open(path, "r");
  let bytesRead = 0;
  const read = handle.read.bind(handle);
  const counted = new Proxy(handle, {
    get: (target, key) =>
      key === "read"
        ? async (...args: Parameters<typeof read>) => {
            const result = await read(...args);
            bytesRead += result.bytesRead;
            return result;
          }
        : Reflect.get(target, key),
  });
  try {
    return {
      result: await probeBunStandaloneGraph(
        counted,
        bytes.length,
        undefined,
        limits,
      ),
      bytesRead,
    };
  } finally {
    await handle.close();
  }
}

it.each([
  ["Mach-O", machoBunSection],
  ["PE", peBunSection],
  ["ELF", elfBunSection],
] as const)(
  "decodes section carrier %s with preserved names and auxiliary regions",
  async (_name, carrier) => {
    const result = await locate(
      carrier(
        bunPrefixedPayload(
          bunModuleGraphPayload({
            modules: [
              {
                name: "/$bunfs/root/main.js",
                contents: Buffer.from("hello"),
                sourcemap: Buffer.from("map"),
                bytecode: Buffer.from([1]),
              },
            ],
            compileExecArgv: "--smol",
          }),
        ),
      ),
    );
    expect(result.status).toBe("present");
    if (result.status !== "present" || !result.graph)
      throw new Error("missing graph");
    const decoded = await decodeBunModuleGraph(result.graph);
    expect(decoded.compileExecArgv.text).toBe("--smol");
    expect(decoded.modules[0]).toMatchObject({
      nameText: { text: "/$bunfs/root/main.js" },
      contents: { length: 5 },
      sourcemap: { length: 3 },
      bytecode: { length: 1 },
    });
  },
);

it.each([0, 16])(
  "decodes legacy Mach-O four-byte prefixes with %s padding bytes",
  async (padding) => {
    const payload = bunModuleGraphPayload({
      revision: "bun-1.3.3",
      modules: [
        { name: "/$bunfs/root/main.js", contents: Buffer.from("hello") },
      ],
    });
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(payload.length);
    const bytes = machoBunSection(
      Buffer.concat([prefix, payload, Buffer.alloc(padding)]),
    );
    const result = await locate(bytes);
    if (result.status !== "present" || !result.graph)
      throw new Error("missing graph");
    expect(result.graph.carrier).toBe("mach-o-section");
    expect(result.graph.payloadOffset).toBe(
      bytes.length - padding - payload.length,
    );
    expect(result.graph.payloadLength).toBe(payload.length);
    const module = (await decodeBunModuleGraph(result.graph)).modules[0]!;
    expect(module.nameText.text).toBe("/$bunfs/root/main.js");
    expect(
      (
        await result.graph.data.read(
          module.contents.offset,
          module.contents.length,
        )
      ).toString(),
    ).toBe("hello");
  },
);

it.each(["trailer", "byte_count"])(
  "rejects legacy Mach-O prefixes with invalid %s",
  async (field) => {
    const payload = bunModuleGraphPayload({
      revision: "bun-1.3.3",
      modules: [{ name: "/$bunfs/root/main.js" }],
    });
    if (field === "trailer") payload[payload.length - 1] = 0;
    else
      payload.writeBigUInt64LE(
        0n,
        payload.length - BUN_FIXTURE_GRAPH_SUFFIX_BYTES,
      );
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(payload.length);
    expect(
      await locate(machoBunSection(Buffer.concat([prefix, payload]))),
    ).toMatchObject({ status: "present", failure: expect.anything() });
  },
);

it.each(["bun-1.3.3", "bun-1.3.9"] as const)(
  "decodes appended %s and retains duplicate names",
  async (revision) => {
    const result = await locate(
      elfAppendedBunPayload(
        bunModuleGraphPayload({
          revision,
          modules: [{ name: "same" }, { name: "same" }],
        }),
      ),
    );
    if (result.status !== "present" || !result.graph)
      throw new Error("missing graph");
    expect(
      (await decodeBunModuleGraph(result.graph)).modules.map(
        (m) => m.nameText.text,
      ),
    ).toEqual(["same", "same"]);
  },
);

it.each([
  [
    { modules: [{ contentsPointer: { offset: 99999, length: 1 } }] },
    "pointer exceeds",
  ],
  [{ modules: [{}], tableLength: 53 }, "unsupported"],
  [
    { modules: [{ loader: 0, moduleFormat: 0 }], tableLength: 468 },
    "more than one known revision",
  ],
  [{ modules: [{}], entryPointId: 8 }, "entry_point_id"],
])("fails closed for invalid module declarations", async (input, reason) => {
  const result = await locate(
    elfAppendedBunPayload(bunModuleGraphPayload(input)),
  );
  if (result.status !== "present" || !result.graph)
    throw new Error("missing graph");
  const graph = result.graph;
  await expect(decodeBunModuleGraph(graph)).rejects.toThrow(reason);
});

it("recognizes a truncated section as malformed", async () => {
  const section = bunPrefixedPayload(bunModuleGraphPayload({ modules: [{}] }));
  const result = await locate(
    machoBunSection(section.subarray(0, section.length - 1)),
  );
  expect(result).toMatchObject({
    status: "present",
    failure: { reason: "format" },
  });
});

it("locates the legacy trailer before its final carrier length", async () => {
  const bytes = elfAppendedBunPayload(
    bunModuleGraphPayload({ modules: [{ name: "main.js" }] }),
  );
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(bytes.length + 8));
  const result = await locate(Buffer.concat([bytes, length]));
  if (result.status !== "present" || !result.graph)
    throw new Error("missing graph");
  expect((await decodeBunModuleGraph(result.graph)).modules).toHaveLength(1);
});

it("rejects truncated length prefixes and ignores empty placeholders", async () => {
  expect(await locate(machoBunSection(Buffer.from([1])))).toMatchObject({
    status: "present",
    failure: { reason: "format" },
  });
  expect(await locate(machoBunSection(Buffer.alloc(8)))).toEqual({
    status: "absent",
  });
});

it.each([
  {
    name: "Mach-O section",
    carrier: (payload: Buffer) => machoBunSection(bunPrefixedPayload(payload)),
    breakExtent: (bytes: Buffer, payload: Buffer) =>
      bytes.writeBigUInt64LE(
        BigInt(payload.length + 1),
        bytes.length - payload.length - 8,
      ),
  },
  {
    name: "appended ELF trailer",
    carrier: elfAppendedBunPayload,
    breakExtent: (bytes: Buffer) =>
      bytes.writeBigUInt64LE(
        BigInt(bytes.length),
        bytes.length - BUN_FIXTURE_GRAPH_SUFFIX_BYTES,
      ),
  },
])(
  "checks the $name payload extent before its configured limit",
  async ({ carrier, breakExtent }) => {
    const payload = bunModuleGraphPayload({ modules: [{ name: "main.js" }] });
    const bytes = carrier(payload);
    const limits = {
      ...DEFAULT_BUN_READER_LIMITS,
      payload_bytes: payload.length - 1,
    };
    expect((await probe(bytes, limits)).result).toMatchObject({
      status: "present",
      failure: {
        reason: "limit",
        readerLimit: { parameter: "artifact_limits.bun.payload_bytes" },
      },
    });
    breakExtent(bytes, payload);
    expect((await probe(bytes, limits)).result).toMatchObject({
      status: "present",
      failure: {
        reason: "format",
        message: expect.stringContaining("truncated"),
      },
    });
  },
);

it("reports an impossible Bun suffix byte count as a format error", async () => {
  const payload = bunModuleGraphPayload({ modules: [{ name: "main.js" }] });
  const limits = {
    ...DEFAULT_BUN_READER_LIMITS,
    payload_bytes: payload.length,
  };
  const section = () => peBunSection(bunPrefixedPayload(payload));
  expect((await probe(section(), limits)).result).toMatchObject({
    status: "present",
    claim: { payloadLength: payload.length },
  });
  payload.writeBigUInt64LE(
    BigInt(payload.length + 1),
    payload.length - BUN_FIXTURE_GRAPH_SUFFIX_BYTES,
  );
  expect((await probe(section(), limits)).result).toMatchObject({
    status: "present",
    failure: {
      reason: "format",
      message: expect.stringContaining("byte_count"),
    },
  });
});

it("refuses multiple embedded graphs instead of selecting one", async () => {
  const section = bunPrefixedPayload(bunModuleGraphPayload({ modules: [{}] }));
  expect(await locate(machoBunSections([section, section]))).toMatchObject({
    status: "present",
    failure: { reason: "unavailable" },
  });
});

it.each([
  ["zero-fill", (bytes: Buffer) => bytes.writeUInt32LE(0x12, 32 + 72 + 64)],
  ["file extent", (bytes: Buffer) => bytes.writeBigUInt64LE(1n, 32 + 48)],
  [
    "virtual extent",
    (bytes: Buffer) => bytes.writeBigUInt64LE(1n, 32 + 72 + 32),
  ],
] as const)(
  "refuses a named Mach-O Bun section with invalid %s backing",
  async (reason, change) => {
    const section = bunPrefixedPayload(
      bunModuleGraphPayload({ modules: [{}] }),
    );
    const bytes = machoBunSection(section);
    change(bytes);
    expect(await locate(bytes)).toMatchObject({
      status: "present",
      failure: { reason: "format", message: expect.stringContaining(reason) },
    });
  },
);

it.each(["thin", "universal"] as const)(
  "requires a Bun segment to fit its %s Mach-O image",
  async (format) => {
    const payload = bunPrefixedPayload(
      bunModuleGraphPayload({
        modules: [{ name: "main.js", contents: Buffer.from("body") }],
      }),
    );
    const wrap = (thin: Buffer) =>
      format === "thin"
        ? thin
        : universalMacho([{ bytes: thin, cpuType: CPU_ARM64, cpuSubtype: 0 }])
            .bytes;
    const thin = machoBunSection(payload);
    const control = await probe(wrap(thin));
    expect(control.result).toMatchObject({
      status: "present",
      claim: { carrier: "mach-o-section" },
    });
    const malformed = Buffer.from(thin);
    const segment = 32;
    const size = BigInt(payload.length) + 1n;
    malformed.writeBigUInt64LE(size, segment + 32);
    malformed.writeBigUInt64LE(size, segment + 48);
    // The universal fixture pads after the slice. The excess byte is outside
    // the slice even when the outer file has bytes at that offset.
    const { result } = await probe(wrap(malformed));
    expect(result).toMatchObject({
      status: "present",
      failure: {
        reason: "format",
        message: expect.stringContaining("segment range is outside the file"),
      },
    });
  },
);

it.each(["cpu-type", "cpu-subtype"] as const)(
  "requires a matching FAT %s for a Bun section claim",
  async (field) => {
    const thin = (name: string) =>
      machoBunSection(
        bunPrefixedPayload(bunModuleGraphPayload({ modules: [{ name }] })),
      );
    const candidate = {
      bytes: thin("candidate.js"),
      cpuType: CPU_ARM64,
      cpuSubtype: 0,
    };
    const conflicting = {
      ...candidate,
      ...(field === "cpu-type"
        ? { tableCpuType: CPU_X86_64 }
        : { tableCpuSubtype: 1 }),
    };
    const matching = universalMacho([candidate]);
    expect((await probe(matching.bytes)).result).toMatchObject({
      status: "present",
      claim: { carrier: "mach-o-section" },
    });
    const wrong = universalMacho([conflicting]);
    const unpadded = wrong.bytes.subarray(
      0,
      wrong.slices[0]!.offset + wrong.slices[0]!.size,
    );
    expect((await probe(unpadded)).result).toMatchObject({
      status: "present",
      failure: {
        reason: "format",
        message: expect.stringContaining("CPU type/subtype disagrees"),
      },
    });
    const unnamed = Buffer.from(conflicting.bytes);
    unnamed.write("__note", 32 + 72);
    expect(
      (await probe(universalMacho([{ ...conflicting, bytes: unnamed }]).bytes))
        .result,
    ).toEqual({ status: "absent" });
    const validSibling = { ...candidate, bytes: thin("independent.js") };
    const mixed = universalMacho([conflicting, validSibling]);
    const result = await locate(mixed.bytes);
    if (result.status !== "present" || !result.graph)
      throw new Error("Expected the independent Bun graph");
    expect(
      (await decodeBunModuleGraph(result.graph)).modules[0]?.nameText.text,
    ).toBe("independent.js");
    const oversizedCommands = machoBunSections([
      bunPrefixedPayload(
        bunModuleGraphPayload({ modules: [{ name: "first.js" }] }),
      ),
      bunPrefixedPayload(
        bunModuleGraphPayload({ modules: [{ name: "second.js" }] }),
      ),
    ]);
    const limited = universalMacho([
      { ...conflicting, bytes: oversizedCommands },
      validSibling,
    ]);
    const { result: underBudget } = await probe(limited.bytes, {
      ...DEFAULT_BUN_READER_LIMITS,
      recognition_load_command_bytes: validSibling.bytes.readUInt32LE(20),
    });
    expect(underBudget).toMatchObject({
      status: "present",
      claim: {
        carrier: "mach-o-section",
        payloadOffset: limited.slices[1]!.offset + 32 + 72 + 80 + 8,
      },
    });
  },
);

it("keeps refused FAT bytes outside the appended graph fallback", async () => {
  const graph = (name: string) =>
    bunModuleGraphPayload({ modules: [{ name }] });
  const thin = machoBunSection(bunPrefixedPayload(graph("refused.js")));
  const fixture = universalMacho([
    {
      bytes: thin,
      cpuType: CPU_ARM64,
      cpuSubtype: 0,
      tableCpuType: CPU_X86_64,
    },
  ]);
  const slice = fixture.slices[0]!;
  const unpadded = fixture.bytes.subarray(0, slice.offset + slice.size);
  const limits = {
    ...DEFAULT_BUN_READER_LIMITS,
    recognition_load_command_bytes: thin.readUInt32LE(20) - 1,
  };
  expect((await probe(unpadded, limits)).result).toEqual({ status: "absent" });

  const outside = graph("outside.js");
  const outer = Buffer.concat([unpadded, outside]);
  for (const selected of [limits, DEFAULT_BUN_READER_LIMITS]) {
    expect((await probe(outer, selected)).result).toMatchObject({
      status: "present",
      claim: {
        carrier: "appended-trailer",
        payloadOffset: unpadded.length,
        payloadLength: outside.length,
      },
    });
  }

  const legacySize = Buffer.alloc(8);
  legacySize.writeBigUInt64LE(BigInt(outer.length + legacySize.length));
  expect(
    (await probe(Buffer.concat([outer, legacySize]), limits)).result,
  ).toMatchObject({
    status: "present",
    claim: {
      carrier: "appended-trailer",
      payloadOffset: unpadded.length,
      payloadLength: outside.length,
    },
  });

  // The footer is outside, but its reported data begins one byte in the
  // refused slice. Both the footer and the full graph span must be eligible.
  const overlapping = Buffer.from(outside);
  const offsets = overlapping.length - BUN_FIXTURE_GRAPH_SUFFIX_BYTES;
  overlapping.writeBigUInt64LE(
    overlapping.readBigUInt64LE(offsets) + 1n,
    offsets,
  );
  expect(
    (await probe(Buffer.concat([unpadded, overlapping]), limits)).result,
  ).toEqual({
    status: "absent",
  });
});

it("probes a section graph without reading its payload data", async () => {
  const contents = Buffer.alloc(1024 * 1024, 0x61);
  const bytes = machoBunSection(
    bunPrefixedPayload(
      bunModuleGraphPayload({ modules: [{ name: "main.js", contents }] }),
    ),
  );
  const { result, bytesRead } = await probe(bytes);
  expect(result).toMatchObject({
    status: "present",
    claim: { carrier: "mach-o-section" },
  });
  expect(bytesRead).toBeLessThan(4096);
});

it.each([
  [
    "Mach-O",
    (section: Buffer) => {
      const bytes = machoBunSection(Buffer.concat([section, Buffer.alloc(16)]));
      return bytes.subarray(0, bytes.length - 8);
    },
  ],
  [
    "ELF",
    (section: Buffer) => {
      const bytes = elfBunSection(section);
      const sectionOffset = 64 + "\0.shstrtab\0.bun\0".length;
      bytes.writeBigUInt64LE(
        BigInt(bytes.length - sectionOffset + 1),
        bytes.length - 64 + 32,
      );
      return bytes;
    },
  ],
] as const)(
  "rejects %s sections whose declared tail is missing",
  async (_name, carrier) => {
    const section = bunPrefixedPayload(
      bunModuleGraphPayload({ modules: [{ name: "main.js" }] }),
    );
    expect(await locate(carrier(section))).toMatchObject({
      status: "present",
      failure: {
        reason: "format",
        message: expect.stringContaining("past the end of the file"),
      },
    });
  },
);

it("requires PE raw section padding to fit before reading a Bun graph", async () => {
  const payload = bunPrefixedPayload(
    bunModuleGraphPayload({ modules: [{ name: "main.js" }] }),
  );
  const valid = peBunSection(payload);
  expect((await probe(valid)).result).toMatchObject({
    status: "present",
    claim: { carrier: "pe-section" },
  });
  // Only file-alignment padding is missing. The complete virtual section and
  // the rest of the PE declarations are byte-identical to the valid control.
  expect((await probe(valid.subarray(0, -1))).result).toMatchObject({
    status: "present",
    failure: {
      reason: "format",
      message: expect.stringContaining("past the end of the file"),
    },
  });
});

it("reads a shared long ELF section name once without materializing its string table", async () => {
  const shnum = 16_383;
  const stringOffset = 64;
  const strings = Buffer.alloc(1024 * 1024, 0x61);
  strings[0] = 0;
  strings[strings.length - 1] = 0;
  const tableOffset = stringOffset + strings.length;
  const bytes = Buffer.alloc(tableOffset + shnum * 64);
  elfPrefix().copy(bytes, 0);
  bytes.writeBigUInt64LE(BigInt(tableOffset), 40);
  bytes.writeUInt16LE(64, 58);
  bytes.writeUInt16LE(shnum, 60);
  bytes.writeUInt16LE(1, 62);
  strings.copy(bytes, stringOffset);
  for (let index = 1; index < shnum; index += 1) {
    const header = tableOffset + index * 64;
    bytes.writeUInt32LE(1, header);
    bytes.writeUInt32LE(index === 1 ? 3 : 1, header + 4);
    bytes.writeBigUInt64LE(BigInt(stringOffset), header + 24);
    bytes.writeBigUInt64LE(BigInt(strings.length), header + 32);
  }
  const observed = await probe(bytes);
  expect(observed.result).toEqual({ status: "absent" });
  expect(observed.bytesRead).toBeLessThan(shnum * 64 + 1024);
});

it("refuses an excessive table count before reading or allocating the module table", async () => {
  const count = 100_001;
  const result = await locate(
    elfAppendedBunPayload(
      bunModuleGraphPayload({ modules: [{}], tableLength: count * 52 }),
    ),
  );
  if (result.status !== "present" || result.graph === undefined)
    throw new Error("Missing graph");
  const read = vi.fn(result.graph.data.read);
  await expect(
    decodeBunModuleGraph({
      ...result.graph,
      data: { ...result.graph.data, read },
    }),
  ).rejects.toMatchObject({
    reason: "limit",
    boundary: "capacity",
    readerLimit: {
      parameter: "artifact_limits.bun.module_count",
      effective_value: 100_000,
      required_value: 100_001,
      unit: "count",
    },
  });
  expect(read).not.toHaveBeenCalled();
});

it.each([
  {
    carrier: "ELF",
    encode: elfBunSection,
    field: "recognition_table_bytes",
    needed: 192,
  },
  {
    carrier: "Mach-O",
    encode: machoBunSection,
    field: "recognition_load_command_bytes",
    needed: 152,
  },
] as const)(
  "keeps $carrier recognition unknown at its selected boundary and recovers the same graph",
  async ({ encode, field, needed }) => {
    const bytes = encode(
      bunPrefixedPayload(
        bunModuleGraphPayload({
          modules: [{ name: "main.js", contents: Buffer.from("retained") }],
        }),
      ),
    );
    const limited = await probe(bytes, {
      ...DEFAULT_BUN_READER_LIMITS,
      [field]: needed - 1,
    });
    expect(limited.result).toMatchObject({
      status: "limited",
      failure: {
        reason: "limit",
        readerLimit: {
          parameter: `artifact_limits.bun.${field}`,
          effective_value: needed - 1,
          required_value: needed,
        },
      },
    });
    const recovered = await probe(bytes, {
      ...DEFAULT_BUN_READER_LIMITS,
      [field]: needed,
    });
    expect(recovered.result).toMatchObject({
      status: "present",
      claim: {
        carrier: encode === elfBunSection ? "elf-section" : "mach-o-section",
      },
    });
  },
);

it("recognizes an ELF Bun section name deep in the string table by reading only that name", async () => {
  const bytes = elfBunSection(
    bunPrefixedPayload(
      bunModuleGraphPayload({
        modules: [{ name: "main.js", contents: Buffer.from("retained") }],
      }),
    ),
    1024 * 1024 + 8,
  );
  const observed = await probe(bytes);
  expect(observed.result).toMatchObject({
    status: "present",
    claim: { carrier: "elf-section" },
  });
  expect(observed.bytesRead).toBeLessThan(1024);
});

it.each([
  ["missing command", (image: Buffer) => image.writeUInt32LE(2, 16)],
  [
    "unused command bytes",
    (image: Buffer) => image.writeUInt32LE(image.readUInt32LE(20) + 8, 20),
  ],
] as const)("refuses a Mach-O Bun graph with %s", async (_label, damage) => {
  const image = machoBunSection(
    bunPrefixedPayload(
      bunModuleGraphPayload({
        modules: [{ name: "main.js", contents: Buffer.from("hello") }],
      }),
    ),
  );
  damage(image);
  const { result } = await probe(image);
  expect(result).toMatchObject({
    status: "present",
    failure: { reason: "format" },
  });
});

it("preserves Bun metadata UTF-8 text and keeps undecodable bytes as hex", async () => {
  const result = await locate(
    elfAppendedBunPayload(
      bunModuleGraphPayload({
        modules: [
          { name: "\uFEFF資料𐐷.js" },
          { name: Buffer.from([0xc3, 0x28]) },
        ],
        compileExecArgv: Buffer.from([0xff]),
      }),
    ),
  );
  if (result.status !== "present" || !result.graph)
    throw new Error("missing graph");
  const decoded = await decodeBunModuleGraph(result.graph);
  expect(decoded.modules.map(({ nameText }) => nameText)).toEqual([
    { text: "\uFEFF資料𐐷.js", hex: null },
    { text: null, hex: "c328" },
  ]);
  expect(decoded.compileExecArgv).toEqual({ text: null, hex: "ff" });
});
