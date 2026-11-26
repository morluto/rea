import { readGoFixture } from "../../fixtures/go/image.js";
import { deflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { machoImageWithUnknownCommand } from "../../../src/artifacts/apple/MachoImage.fixture.js";
import { fat } from "../../../src/domain/binaryTarget.fixture.js";
import {
  createRustImage,
  createRustImageWithGoSection,
  createRustHashOverflowImage,
  createRustWasmModule,
  createWasmSectionFlood,
  compressRustElfSectionNames,
  rustElfSectionNameFixture,
  RUSTC_HASH,
  rustDependencyPayload,
  WASM_MODULE_HEADER,
  wasmCustomSection,
  wasmSection,
} from "../../fixtures/rust/image.js";
import { readRustBinaryImageFromHandle } from "../../../src/rust/RustBinaryImage.js";
import { readBinaryContainer } from "../../../src/domain/native/readBinaryContainer.js";
import { ParseFailureError } from "../../../src/domain/parseFailure.js";

const inspectImage = (
  bytes: Buffer,
  maxHashes?: number,
  maxOutputBytes?: number,
  onRead?: (offset: number, length: number) => void,
  pause = async () => {},
) =>
  readRustBinaryImageFromHandle(
    {
      size: bytes.length,
      readRange: async (offset, length) => {
        onRead?.(offset, length);
        return bytes.subarray(offset, offset + length);
      },
    },
    maxHashes,
    maxOutputBytes,
    pause,
  );

const packages = [
  {
    name: "itoa",
    version: "1.0.18",
    source: "crates.io",
    kind: null,
    dependencies: [],
    features: null,
    root: false,
  },
  {
    name: "sample",
    version: "0.1.0",
    source: "local",
    kind: null,
    dependencies: [0],
    features: null,
    root: true,
  },
];

it.each([
  ["named", ".rodata"],
  ["empty", ""],
  ["unavailable", null],
] as const)(
  "retains read-only ELF section bytes with a %s name",
  async (name, expectedName) => {
    const bytes = rustElfSectionNameFixture(name);
    const container = readBinaryContainer(bytes, "elf-directory");
    expect(container.load_regions).toEqual([
      expect.objectContaining({ write: true }),
    ]);
    expect(container.sections).toContainEqual(
      expect.objectContaining({
        format: "elf",
        name: expectedName,
        offset: 2048,
        read_only: true,
        file_backed: true,
      }),
    );
    expect((await inspectImage(bytes)).rustc_commit?.hashes).toEqual([
      { hash: RUSTC_HASH, file_offset: 2048 },
    ]);
  },
);

it.each([
  ["writable", 1, 3n],
  ["executable", 1, 6n],
  ["unallocated", 1, 0n],
  ["NOBITS", 8, 2n],
  ["NULL", 0, 2n],
] as const)(
  "does not scan unnamed ELF %s sections for compiler paths",
  async (_kind, type, flags) => {
    const bytes = rustElfSectionNameFixture("empty");
    bytes.writeUInt32LE(type, 384 + 4);
    bytes.writeBigUInt64LE(flags, 384 + 8);
    expect(
      readBinaryContainer(bytes, "elf-directory").sections,
    ).not.toContainEqual(
      expect.objectContaining({ offset: 2048, read_only: true }),
    );
    expect((await inspectImage(bytes)).rustc_commit).toBeNull();
  },
);

it("does not scan an unnamed ELF section whose declared range leaves the file", async () => {
  const bytes = rustElfSectionNameFixture("empty");
  // The compiler path still exists at 2048, but its declared section no longer fits.
  bytes.writeBigUInt64LE(BigInt(bytes.length), 384 + 32);
  expect(
    readBinaryContainer(bytes, "elf-directory").sections,
  ).not.toContainEqual(expect.objectContaining({ read_only: true }));
  expect((await inspectImage(bytes)).rustc_commit).toBeNull();
});

it.each(["elf", "pe"] as const)(
  "reads a .dep-v0 section and an inferred rustc hash from %s",
  async (format) => {
    const image = await inspectImage(createRustImage({ format }));
    expect(image.format).toBe(format);
    expect(image.auditable_metadata).toMatchObject({
      section_name: ".dep-v0",
      file_offset: 1024,
      section_bytes: rustDependencyPayload().length,
      format_version: 1,
      root_package_index: 1,
      packages,
      dependency_edges: [{ from_index: 1, to_index: 0 }],
    });
    expect(image.rustc_commit).toEqual({
      evidence_kind: "inferred",
      hashes: [{ hash: RUSTC_HASH, file_offset: 2048 }],
    });
  },
);

it.each([
  ["\\", [{ hash: RUSTC_HASH, file_offset: 2048 }]],
  ["-", undefined],
] as const)(
  "reads a rustc hash followed by %s only when it is a path separator",
  async (separator, hashes) => {
    // Windows builds store /rustc/<hash>\library\...; the fixture path is at 2048.
    const bytes = createRustImage({ format: "pe" });
    bytes.write(
      separator,
      2048 + "/rustc/".length + RUSTC_HASH.length,
      "latin1",
    );
    expect((await inspectImage(bytes)).rustc_commit?.hashes).toEqual(hashes);
  },
);

it("reads a Mach-O __DATA,.dep-v0 section", async () => {
  const image = await inspectImage(createRustImage({ format: "macho" }));
  expect(image).toMatchObject({
    format: "macho",
    architecture: "arm64",
    auditable_metadata: {
      section_name: "__DATA,.dep-v0",
      file_offset: 1024,
      root_package_index: 1,
      packages,
    },
    rustc_commit: {
      evidence_kind: "inferred",
      hashes: [{ hash: RUSTC_HASH, file_offset: 2048 }],
    },
  });
});

it("preserves the 32-bit width of a thin Mach-O with no dependency section", async () => {
  const bytes = Buffer.from(machoImageWithUnknownCommand(false, 12));
  expect(await inspectImage(bytes)).toMatchObject({
    format: "macho",
    bits: 32,
    auditable_metadata: null,
  });
});

it("reads a .dep-v0 custom section and a data-section rustc hash from a WebAssembly module", async () => {
  const bytes = createRustWasmModule();
  expect(await inspectImage(bytes)).toEqual({
    format: "wasm",
    architecture: "wasm",
    bits: null,
    byte_order: "little",
    auditable_metadata: expect.objectContaining({
      section_name: ".dep-v0",
      file_offset: bytes.indexOf(rustDependencyPayload()),
      section_bytes: rustDependencyPayload().length,
      format_version: 1,
      root_package_index: 1,
      packages,
      dependency_edges: [{ from_index: 1, to_index: 0 }],
    }),
    rustc_commit: {
      evidence_kind: "inferred",
      hashes: [{ hash: RUSTC_HASH, file_offset: bytes.indexOf("/rustc/") }],
    },
  });
});

it("returns null metadata for a WebAssembly module without .dep-v0", async () => {
  const bytes = createRustWasmModule({ omitSection: true });
  const image = await inspectImage(bytes);
  expect(image).toMatchObject({ format: "wasm", bits: null });
  expect(image.auditable_metadata).toBeNull();
  expect(image.rustc_commit?.hashes).toEqual([
    { hash: RUSTC_HASH, file_offset: bytes.indexOf("/rustc/") },
  ]);
});

it.each([
  [
    "a component",
    Buffer.from("0061736d0d000100", "hex"),
    { kind: "unsupported", format: "wasm", offset: 6, field: "layer" },
  ],
  [
    "a pre-release core module",
    Buffer.from("0061736d0d000000", "hex"),
    { kind: "unsupported", format: "wasm", offset: 4, field: "version" },
  ],
  [
    "a truncated header",
    WASM_MODULE_HEADER.subarray(0, 6),
    { kind: "truncated", format: "wasm", offset: 0 },
  ],
  [
    "a section past the end of the file",
    Buffer.concat([WASM_MODULE_HEADER, Buffer.from([0x01, 0x05, 0x00])]),
    { kind: "truncated", format: "wasm", offset: 8, field: "section" },
  ],
  [
    "a section size cut off by the end of the file",
    Buffer.concat([WASM_MODULE_HEADER, Buffer.from([0x00, 0x80])]),
    { kind: "truncated", format: "wasm", offset: 9, field: "section size" },
  ],
  [
    "a custom name length cut off by its section",
    Buffer.concat([
      WASM_MODULE_HEADER,
      wasmSection(0, Buffer.from([0x80])),
      wasmSection(1, Buffer.from([0x00])),
    ]),
    {
      kind: "malformed",
      format: "wasm",
      offset: 10,
      field: "custom section name length",
    },
  ],
  [
    "a custom name length cut off by the final section",
    Buffer.concat([WASM_MODULE_HEADER, wasmSection(0, Buffer.from([0x80]))]),
    {
      kind: "malformed",
      format: "wasm",
      offset: 10,
      field: "custom section name length",
    },
  ],
  [
    "a section size over 32 bits",
    Buffer.concat([
      WASM_MODULE_HEADER,
      Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff, 0x1f]),
    ]),
    { kind: "malformed", format: "wasm", offset: 9, field: "section size" },
  ],
  [
    "a custom name past its section",
    Buffer.concat([
      WASM_MODULE_HEADER,
      wasmSection(0, Buffer.from([0x05, 0x61])),
    ]),
    {
      kind: "malformed",
      format: "wasm",
      offset: 10,
      field: "custom section name",
    },
  ],
  [
    "a non-UTF-8 custom section name",
    Buffer.concat([
      WASM_MODULE_HEADER,
      wasmCustomSection(Buffer.from([0xff]), Buffer.alloc(0)),
    ]),
    {
      kind: "malformed",
      format: "wasm",
      offset: 11,
      field: "custom section name",
    },
  ],
  [
    "a second data section",
    createRustWasmModule({ sections: [wasmSection(11, Buffer.from([0]))] }),
    { kind: "malformed", format: "wasm", field: "data section" },
  ],
] as const)("refuses WebAssembly with %s", async (_name, bytes, failure) => {
  await expect(inspectImage(bytes)).rejects.toThrow(
    expect.objectContaining({
      failure: expect.objectContaining(failure),
    }),
  );
});

it("reports a duplicate .dep-v0 section ahead of the section bound that follows it", async () => {
  const bytes = createRustWasmModule({
    sections: [
      wasmCustomSection(".dep-v0", rustDependencyPayload()),
      createWasmSectionFlood(65_537).subarray(WASM_MODULE_HEADER.length),
    ],
  });
  await expect(inspectImage(bytes)).rejects.toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "malformed",
        format: "rust-auditable",
      }),
    }),
  );
});

it("accepts a WebAssembly module at the exact section limit", async () => {
  expect(
    (await inspectImage(createWasmSectionFlood(65_536))).auditable_metadata,
  ).toBeNull();
});

it.each([
  ["a truncated size", Buffer.from([0x00, 0x80]), "truncated", "section size"],
  [
    "an overflowing size",
    Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff, 0x1f]),
    "malformed",
    "section size",
  ],
  ["missing contents", Buffer.from([0x00, 0x01]), "truncated", "section"],
] as const)(
  "reports %s at the WebAssembly section limit",
  async (_name, tail, kind, field) => {
    const prefix = createWasmSectionFlood(65_536);
    const bytes = Buffer.concat([prefix, tail]);
    await expect(inspectImage(bytes)).rejects.toThrow(
      expect.objectContaining({
        failure: expect.objectContaining({
          kind,
          format: "wasm",
          field,
          offset: field === "section size" ? prefix.length + 1 : prefix.length,
        }),
      }),
    );
  },
);

it("ignores PE file-alignment padding after the dependency content", async () => {
  const bytes = createRustImage({ format: "pe", includeRustc: false });
  const payloadBytes = rustDependencyPayload().length;
  const entry = 264;
  expect(bytes.readUInt32LE(entry + 8)).toBe(payloadBytes);
  bytes.writeUInt32LE(512, entry + 16);
  const image = await inspectImage(bytes);
  expect(image.auditable_metadata).toMatchObject({
    section_name: ".dep-v0",
    section_bytes: payloadBytes,
    packages,
  });
});

it("refuses invalid zlib and PE padding without its required layout facts", async () => {
  const payloadBytes = rustDependencyPayload().length;
  const entry = 264;
  const bytes = createRustImage({ format: "pe", includeRustc: false });
  bytes.writeUInt32LE(0, entry + 8);
  bytes.writeUInt32LE(512, entry + 16);
  bytes.writeUInt32LE(512, 188); // Optional-header FileAlignment.
  const payloadOffset = 1024;
  const nonzeroSuffix = Buffer.from(bytes);
  nonzeroSuffix[payloadOffset + payloadBytes] = 1;
  await expect(inspectImage(nonzeroSuffix)).rejects.toThrow(
    /bytes after the zlib stream/u,
  );

  const corruptChecksum = Buffer.from(bytes);
  corruptChecksum[payloadOffset + payloadBytes - 1] =
    corruptChecksum[payloadOffset + payloadBytes - 1]! ^ 0xff;
  await expect(inspectImage(corruptChecksum)).rejects.toThrow(
    /complete zlib stream/u,
  );

  const nonzeroVirtualSize = Buffer.from(bytes);
  nonzeroVirtualSize.writeUInt32LE(payloadBytes + 1, entry + 8);
  await expect(inspectImage(nonzeroVirtualSize)).rejects.toThrow(
    /bytes after the zlib stream/u,
  );

  const unknownAlignment = Buffer.from(bytes);
  unknownAlignment.writeUInt32LE(0, 188);
  await expect(inspectImage(unknownAlignment)).rejects.toThrow(
    /bytes after the zlib stream/u,
  );
});

it.each([1, 2])(
  "reads dependency metadata through ELF section-name compression %i",
  async (compressionType) => {
    const image = await inspectImage(
      compressRustElfSectionNames(
        createRustImage({ format: "elf" }),
        compressionType,
      ),
    );
    expect(image.auditable_metadata).toMatchObject({
      section_name: ".dep-v0",
      file_offset: 1024,
      packages,
      dependency_edges: [{ from_index: 1, to_index: 0 }],
    });
  },
);

it("keeps dependency presence unknown for unsupported ELF name compression", async () => {
  const image = await inspectImage(
    compressRustElfSectionNames(createRustImage({ format: "elf" }), 3),
  );
  expect(image.auditable_metadata).toBeNull();
  expect(image.section_names_limitation).toMatch(
    /compression type 3 is unsupported/u,
  );
  expect(image.rustc_commit?.hashes).toEqual([
    { hash: RUSTC_HASH, file_offset: 2048 },
  ]);
});

it("keeps dependency presence unknown when its ELF name offset is unreadable", async () => {
  const bytes = createRustImage({ format: "elf" });
  bytes.writeUInt32LE(0xffff, 384);

  const image = await inspectImage(bytes);
  expect(image.auditable_metadata).toBeNull();
  expect(image.section_names_limitation).toMatch(/outside its string table/u);
  expect(image.rustc_commit?.hashes).toEqual([
    { hash: RUSTC_HASH, file_offset: 2048 },
  ]);
});

it("finds rustc paths in read-only ELF load data without section headers", async () => {
  const bytes = createRustImage({
    format: "elf",
    omitSection: true,
    includeRustc: true,
  });
  bytes.writeBigUInt64LE(0n, 40);
  bytes.writeUInt16LE(0, 60);
  bytes.writeUInt16LE(0, 62);
  bytes.writeUInt32LE(4, 132); // PF_R, no write or execute permission.

  expect(await inspectImage(bytes)).toMatchObject({
    auditable_metadata: null,
    rustc_commit: {
      evidence_kind: "inferred",
      hashes: [{ hash: RUSTC_HASH, file_offset: 2048 }],
    },
  });

  bytes.writeUInt32LE(6, 132); // PF_R | PF_W is not read-only data.
  expect((await inspectImage(bytes)).rustc_commit).toBeNull();
});

const thrown = async (read: () => unknown): Promise<unknown> => {
  try {
    await read();
  } catch (cause: unknown) {
    return cause;
  }
  throw new Error("expected a container failure");
};

it("refuses a universal Mach-O container", async () => {
  const cause = await thrown(() => inspectImage(fat([0x0100000c])));
  expect(cause).toBeInstanceOf(ParseFailureError);
  expect(cause).toMatchObject({
    failure: {
      kind: "unsupported",
      detail: expect.stringContaining("thin slice"),
    },
  });
});

it("keeps the container's truncated failure and its facts unchanged", async () => {
  const bytes = createRustImage({ format: "elf" });
  // The fixture's first program header is at byte 128; p_filesz and
  // p_memsz are at +32 and +40.
  bytes.writeBigUInt64LE(BigInt(bytes.length) * 2n, 128 + 32);
  bytes.writeBigUInt64LE(BigInt(bytes.length) * 2n, 128 + 40);
  const rust = await thrown(() => inspectImage(bytes));
  expect(rust).toBeInstanceOf(ParseFailureError);
  expect(rust).toMatchObject({
    failure: {
      kind: "truncated",
      format: "elf",
      offset: 0,
      field: "ELF load segment",
    },
  });
});

it("does not read SHT_NOBITS dependency sections as stored bytes", async () => {
  const bytes = createRustImage({ format: "elf" });
  // The fixture writes the .dep-v0 section header at byte 384.
  bytes.writeUInt32LE(8, 384 + 4);
  expect(await thrown(() => inspectImage(bytes))).toMatchObject({
    failure: { kind: "malformed", format: "rust-auditable" },
  });
});

it("reads a rustc path from a read-only ELF section whose name exceeds 64 bytes", async () => {
  const bytes = createRustImage({ format: "elf", omitSection: true });
  // omitSection places the rustc section header at 384 and shstrtab at 320.
  const nameOffset = bytes.readUInt32LE(384);
  const tableOffset = Number(bytes.readBigUInt64LE(320 + 24));
  const longName = Buffer.concat([Buffer.alloc(65, 0x61), Buffer.from([0])]);
  longName.copy(bytes, tableOffset + nameOffset);
  bytes.writeBigUInt64LE(BigInt(nameOffset + longName.length), 320 + 32);
  const image = await inspectImage(bytes);
  expect(image.auditable_metadata).toBeNull();
  expect(image.rustc_commit).toEqual({
    evidence_kind: "inferred",
    hashes: [{ hash: RUSTC_HASH, file_offset: 2048 }],
  });
});

it("retains dependency facts when compiler paths exceed the selected prefix", async () => {
  const bytes = createRustHashOverflowImage();
  const partial = await inspectImage(bytes);
  expect(partial.auditable_metadata?.packages.map(({ name }) => name)).toEqual([
    "itoa",
    "sample",
  ]);
  expect(partial.rustc_commit?.hashes).toHaveLength(64);
  expect(partial.rustc_commit?.coverage).toEqual({
    status: "partial",
    reason: "max_rustc_hashes",
    effective_limit: 64,
    limit: {
      control_kind: "parameter",
      parameter: "max_rustc_hashes",
      effective_value: 64,
      unit: "count",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      default_value: 64,
      applies_at: "next_call",
    },
  });
  const recovered = await inspectImage(bytes, 65);
  expect(recovered.rustc_commit?.hashes).toHaveLength(65);
  expect(recovered.rustc_commit).not.toHaveProperty("coverage");
  expect(recovered.auditable_metadata).toEqual(partial.auditable_metadata);
});

it.each([
  ["elf", "compressed"],
  ["elf", "unmapped"],
  ["elf", "zero-fill"],
  ["elf", "duplicate"],
  ["elf", "out-of-file"],
  ["elf", "zero-address"],
  ["macho", "unmapped"],
  ["macho", "zero-fill"],
  ["macho", "duplicate"],
  ["macho", "out-of-file"],
] as const)(
  "retains Rust evidence beside an unrelated %s %s Go section",
  async (format, fault) => {
    const bytes = createRustImageWithGoSection(format, fault);
    const control = Buffer.from(bytes);
    const sectionOffset = format === "elf" ? 768 + 11 : 408;
    const sectionName = Buffer.from(
      (format === "elf" ? ".other\0" : "__other\0").padEnd(
        format === "elf" ? 13 : 16,
        "\0",
      ),
      "ascii",
    );
    if (format === "elf") {
      const nameOffset = Number(bytes.readBigUInt64LE(320 + 32));
      sectionName.copy(control, 768 + nameOffset);
    } else {
      sectionName.copy(control, sectionOffset);
    }
    expect(readBinaryContainer(bytes, "elf-directory").load_regions).toEqual(
      readBinaryContainer(control, "elf-directory").load_regions,
    );
    const failureKind =
      fault === "compressed"
        ? "unsupported"
        : fault === "out-of-file"
          ? "truncated"
          : "malformed";
    await expect(readGoFixture(bytes)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/build-info|mapped/i),
        failure: expect.objectContaining({ kind: failureKind }),
      }),
    );
    expect(await inspectImage(bytes)).toMatchObject({
      format,
      auditable_metadata: { file_offset: 1024, packages },
      rustc_commit: {
        evidence_kind: "inferred",
        hashes: [{ hash: RUSTC_HASH, file_offset: 2048 }],
      },
    });
  },
);

const positionalImage = (bytes: Buffer, pause?: () => Promise<void>) => {
  const reads: [offset: number, length: number][] = [];
  return {
    reads,
    inspect: (maxHashes?: number, maxOutputBytes?: number) =>
      inspectImage(
        bytes,
        maxHashes,
        maxOutputBytes,
        (offset, length) => {
          reads.push([offset, length]);
        },
        pause,
      ),
    largestRead: () => Math.max(...reads.map(([, length]) => length)),
  };
};

it("reads overlapping read-only ELF section and load bytes once", async () => {
  const bytes = Buffer.alloc(8192);
  rustElfSectionNameFixture("named").copy(bytes);
  bytes.writeUInt32LE(4, 132); // Read-only PT_LOAD.
  bytes.writeBigUInt64LE(4096n, 136);
  bytes.writeBigUInt64LE(0x401000n, 144);
  bytes.writeBigUInt64LE(4096n, 160);
  bytes.writeBigUInt64LE(4096n, 168);
  bytes.writeBigUInt64LE(0x401800n, 384 + 16);
  bytes.writeBigUInt64LE(6144n, 384 + 24);
  bytes.write(`/rustc/${RUSTC_HASH}/`, 6144);

  const image = positionalImage(bytes);
  expect((await image.inspect()).rustc_commit).toEqual({
    evidence_kind: "inferred",
    hashes: [{ hash: RUSTC_HASH, file_offset: 6144 }],
  });
  expect(
    image.reads.filter(([offset, length]) => offset + length > 4096),
  ).toEqual([[4096, 4096]]);
});

it("retains exact compiler-path offsets across positional scan windows", async () => {
  const window = 1024 * 1024;
  const body = Buffer.alloc(window * 2 + 128);
  const secondHash = "b".repeat(40);
  const first = window - 47;
  const second = 2 * (window - 47) + 1;
  body.write(`/rustc/${RUSTC_HASH}/`, first);
  body.write(`/rustc/${RUSTC_HASH}/`, window + 64);
  body.write(`/rustc/${secondHash}\\`, second);
  const section = wasmSection(11, body);
  const image = positionalImage(Buffer.concat([WASM_MODULE_HEADER, section]));
  const base = WASM_MODULE_HEADER.length + section.length - body.length;
  const hashes = [
    { hash: RUSTC_HASH, file_offset: base + first },
    { hash: secondHash, file_offset: base + second },
  ];
  expect((await image.inspect()).rustc_commit).toEqual({
    evidence_kind: "inferred",
    hashes,
  });
  expect((await image.inspect(1)).rustc_commit).toMatchObject({
    hashes: hashes.slice(0, 1),
    coverage: {
      status: "partial",
      reason: "max_rustc_hashes",
      effective_limit: 1,
    },
  });
  expect((await image.inspect(2, 100)).rustc_commit).toMatchObject({
    hashes: hashes.slice(0, 1),
    coverage: {
      status: "partial",
      reason: "report_bytes",
      effective_limit: 100,
    },
  });
  expect(image.largestRead()).toBeLessThanOrEqual(window);
});

it.each(["valid", "invalid", "cancelled"] as const)(
  "bounds WebAssembly name reads when the split code point is %s",
  async (mode) => {
    const window = 64 * 1024;
    const name = Buffer.alloc(window + 1, 0x61);
    name[window - 1] = 0xc3;
    name[window] = mode === "invalid" ? 0x61 : 0xa9;
    const nameSection = wasmCustomSection(name, Buffer.alloc(0));
    const nameStart =
      WASM_MODULE_HEADER.length + nameSection.length - name.length;
    const cancellation = new Error("cancelled before the second name read");
    const image = positionalImage(
      Buffer.concat([
        WASM_MODULE_HEADER,
        nameSection,
        wasmCustomSection(".dep-v0", rustDependencyPayload()),
      ]),
      async () => {
        if (mode === "cancelled") throw cancellation;
      },
    );
    if (mode === "valid") {
      expect((await image.inspect()).auditable_metadata).toMatchObject({
        packages,
      });
    } else if (mode === "invalid") {
      await expect(image.inspect()).rejects.toMatchObject({
        failure: {
          kind: "malformed",
          format: "wasm",
          field: "custom section name",
          offset: nameStart,
        },
      });
    } else {
      await expect(image.inspect()).rejects.toBe(cancellation);
      expect(image.reads.at(-1)).toEqual([nameStart, window]);
    }
    expect(image.largestRead()).toBe(window);
  },
);

const rustPaddedPeImage = (payload: Buffer) => {
  const alignment = 2 * 1024 * 1024;
  const start = 1024;
  const bytes = Buffer.alloc(start + alignment);
  createRustImage({ format: "pe", includeRustc: false }).copy(bytes);
  bytes.writeUInt32LE(alignment, 188);
  bytes.writeUInt32LE(0, 264 + 8);
  bytes.writeUInt32LE(alignment, 264 + 16);
  bytes.writeUInt32LE(0xc0000040, 264 + 36);
  payload.copy(bytes, start);
  return bytes;
};

it("verifies the entire PE padding after a bounded compressed dependency read", async () => {
  const payload = rustDependencyPayload();
  const bytes = rustPaddedPeImage(payload);
  const valid = positionalImage(bytes);
  expect((await valid.inspect()).auditable_metadata).toMatchObject({
    file_offset: 1024,
    section_bytes: bytes.length - 1024,
    compressed_bytes: payload.length,
    packages,
  });
  expect(valid.largestRead()).toBeLessThanOrEqual(1024 * 1024);
  bytes[bytes.length - 1] = 1;
  const invalid = positionalImage(bytes);
  await expect(invalid.inspect()).rejects.toMatchObject({
    failure: {
      kind: "malformed",
      format: "rust-auditable",
      detail: expect.stringContaining("after the zlib stream"),
    },
  });
  expect(invalid.largestRead()).toBeLessThanOrEqual(1024 * 1024);
});

it("refuses a padded PE compressed stream that cannot end within its read budget", async () => {
  const payload = deflateSync(Buffer.alloc(1024 * 1024), { level: 0 });
  const image = positionalImage(rustPaddedPeImage(payload));
  await expect(image.inspect()).rejects.toMatchObject({
    failure: {
      kind: "limit",
      limit: { name: "compressed dependency bytes", maximum: 1024 * 1024 },
    },
  });
  expect(image.largestRead()).toBeLessThanOrEqual(1024 * 1024);
});

it.each([false, true])(
  "reuses the WebAssembly section probe unless the name length falls outside it (short: %s)",
  async (shortProbe) => {
    const preamble = WASM_MODULE_HEADER.length;
    const nameHeaderOffset = preamble + 2;
    const bytes = Buffer.concat([
      WASM_MODULE_HEADER,
      wasmCustomSection("abc", Buffer.alloc(0)),
      createRustWasmModule().subarray(preamble),
    ]);
    const reads: [offset: number, length: number][] = [];
    const image = await readRustBinaryImageFromHandle(
      {
        size: bytes.length,
        readRange: async (offset, length) => {
          reads.push([offset, length]);
          const end = offset + (shortProbe && offset === preamble ? 2 : length);
          return bytes.subarray(offset, end);
        },
      },
      undefined,
      undefined,
      async () => {},
    );
    expect(image.auditable_metadata).toMatchObject({
      file_offset: bytes.indexOf(rustDependencyPayload()),
      packages,
    });
    const firstFrameEnd = nameHeaderOffset + 4;
    expect(
      reads.filter(([offset]) => offset >= preamble && offset < firstFrameEnd),
    ).toEqual([
      [preamble, 16],
      ...(shortProbe ? [[nameHeaderOffset, 4]] : []),
      [nameHeaderOffset + 1, 3],
    ]);
  },
);
