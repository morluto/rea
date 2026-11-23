import { deflateSync } from "node:zlib";
import { expect, it, vi } from "vitest";
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
import {
  readRustBinaryImage,
  readRustBinaryImageFromHandle,
} from "../../../src/rust/RustBinaryImage.js";
import { readBinaryContainer } from "../../../src/domain/native/readBinaryContainer.js";
import { readGoBinaryImage } from "../../../src/go/GoBinaryImage.js";
import { ParseFailureError } from "../../../src/domain/parseFailure.js";

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
  (name, expectedName) => {
    const bytes = rustElfSectionNameFixture(name);
    const container = readBinaryContainer(bytes, "elf-directory");
    expect(container.load_regions?.every(({ write }) => write)).toBe(true);
    expect(container.sections).toContainEqual(
      expect.objectContaining({
        format: "elf",
        name: expectedName,
        offset: 2048,
        read_only: true,
        file_backed: true,
      }),
    );
    expect(readRustBinaryImage(bytes).rustc_commit?.hashes).toEqual([
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
  (_kind, type, flags) => {
    const bytes = rustElfSectionNameFixture("empty");
    bytes.writeUInt32LE(type, 384 + 4);
    bytes.writeBigUInt64LE(flags, 384 + 8);
    expect(
      readBinaryContainer(bytes, "elf-directory").sections,
    ).not.toContainEqual(
      expect.objectContaining({ offset: 2048, read_only: true }),
    );
    expect(readRustBinaryImage(bytes).rustc_commit).toBeNull();
  },
);

it("does not scan an unnamed ELF section whose declared range leaves the file", () => {
  const bytes = rustElfSectionNameFixture("empty");
  // The compiler path still exists at 2048, but its declared section no longer fits.
  bytes.writeBigUInt64LE(BigInt(bytes.length), 384 + 32);
  expect(
    readBinaryContainer(bytes, "elf-directory").sections,
  ).not.toContainEqual(expect.objectContaining({ read_only: true }));
  expect(readRustBinaryImage(bytes).rustc_commit).toBeNull();
});

it.each(["elf", "pe"] as const)(
  "reads a .dep-v0 section and an inferred rustc hash from %s",
  (format) => {
    const image = readRustBinaryImage(createRustImage({ format }));
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
  (separator, hashes) => {
    // Windows builds store /rustc/<hash>\library\...; the fixture path is at 2048.
    const bytes = createRustImage({ format: "pe" });
    bytes.write(
      separator,
      2048 + "/rustc/".length + RUSTC_HASH.length,
      "latin1",
    );
    expect(readRustBinaryImage(bytes).rustc_commit?.hashes).toEqual(hashes);
  },
);

it("reads a Mach-O __DATA,.dep-v0 section", () => {
  const image = readRustBinaryImage(createRustImage({ format: "macho" }));
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

it("preserves the 32-bit width of a thin Mach-O with no dependency section", () => {
  const bytes = Buffer.from(machoImageWithUnknownCommand(false, 12));
  expect(readRustBinaryImage(bytes)).toMatchObject({
    format: "macho",
    bits: 32,
    auditable_metadata: null,
  });
});

it("reads a .dep-v0 custom section and a data-section rustc hash from a WebAssembly module", () => {
  const bytes = createRustWasmModule();
  expect(readRustBinaryImage(bytes)).toEqual({
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

it("returns null metadata for a WebAssembly module without .dep-v0", () => {
  const bytes = createRustWasmModule({ omitSection: true });
  const image = readRustBinaryImage(bytes);
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
] as const)("refuses WebAssembly with %s", (_name, bytes, failure) => {
  expect(() => readRustBinaryImage(bytes)).toThrow(
    expect.objectContaining({
      failure: expect.objectContaining(failure),
    }),
  );
});

it("reports a duplicate .dep-v0 section ahead of the section bound that follows it", () => {
  const bytes = createRustWasmModule({
    sections: [
      wasmCustomSection(".dep-v0", rustDependencyPayload()),
      createWasmSectionFlood(65_537).subarray(WASM_MODULE_HEADER.length),
    ],
  });
  expect(() => readRustBinaryImage(bytes)).toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "malformed",
        format: "rust-auditable",
      }),
    }),
  );
});

it("bounds the synchronous WebAssembly section walk", () => {
  expect(
    readRustBinaryImage(createWasmSectionFlood(65_536)).auditable_metadata,
  ).toBeNull();
  expect(() => readRustBinaryImage(createWasmSectionFlood(65_537))).toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "limit",
        format: "wasm",
        limit: { name: "max_wasm_sections", maximum: 65_536 },
      }),
    }),
  );
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
  (_name, tail, kind, field) => {
    const bytes = Buffer.concat([createWasmSectionFlood(65_536), tail]);
    expect(() => readRustBinaryImage(bytes)).toThrow(
      expect.objectContaining({
        failure: expect.objectContaining({ kind, format: "wasm", field }),
      }),
    );
  },
);

it("preserves the arm64_32 Mach-O CPU family when dependency metadata is absent", () => {
  const bytes = createRustImage({
    format: "macho",
    omitSection: true,
    includeRustc: false,
  });
  bytes.writeUInt32LE(0x0200000c, 4);

  expect(readRustBinaryImage(bytes)).toMatchObject({
    format: "macho",
    architecture: "arm64_32",
    bits: 64,
    auditable_metadata: null,
    rustc_commit: null,
  });
});

it("uses the shared ELF classifier for Rust image architecture", () => {
  const bytes = createRustImage({
    format: "elf",
    omitSection: true,
    includeRustc: true,
  });
  bytes.writeUInt16LE(164, 18); // ELF EM_HEXAGON.
  expect(readRustBinaryImage(bytes)).toMatchObject({
    format: "elf",
    architecture: "hexagon",
    auditable_metadata: null,
  });
});

it("ignores PE file-alignment padding after the dependency content", () => {
  const bytes = createRustImage({ format: "pe", includeRustc: false });
  const payloadBytes = rustDependencyPayload().length;
  const entry = 264;
  expect(bytes.readUInt32LE(entry + 8)).toBe(payloadBytes);
  bytes.writeUInt32LE(512, entry + 16);
  const image = readRustBinaryImage(bytes);
  expect(image.auditable_metadata).toMatchObject({
    section_name: ".dep-v0",
    section_bytes: payloadBytes,
    packages,
  });
});

it("recognizes zero-virtual-size PE raw padding without accepting payload junk", () => {
  const payloadBytes = rustDependencyPayload().length;
  const entry = 264;
  const bytes = createRustImage({ format: "pe", includeRustc: false });
  bytes.writeUInt32LE(0, entry + 8);
  bytes.writeUInt32LE(512, entry + 16);
  bytes.writeUInt32LE(512, 188); // Optional-header FileAlignment.
  expect(readRustBinaryImage(bytes).auditable_metadata).toMatchObject({
    section_bytes: 512,
    compressed_bytes: payloadBytes,
    packages,
  });

  const payloadOffset = bytes.readUInt32LE(entry + 20);
  const nonzeroSuffix = Buffer.from(bytes);
  nonzeroSuffix[payloadOffset + payloadBytes] = 1;
  expect(() => readRustBinaryImage(nonzeroSuffix)).toThrow(
    /bytes after the zlib stream/u,
  );

  const truncated = Buffer.from(bytes);
  truncated[payloadOffset + payloadBytes - 1] =
    truncated[payloadOffset + payloadBytes - 1]! ^ 0xff;
  expect(() => readRustBinaryImage(truncated)).toThrow(/complete zlib stream/u);

  const nonzeroVirtualSize = Buffer.from(bytes);
  nonzeroVirtualSize.writeUInt32LE(payloadBytes + 1, entry + 8);
  expect(() => readRustBinaryImage(nonzeroVirtualSize)).toThrow(
    /bytes after the zlib stream/u,
  );

  const unknownAlignment = Buffer.from(bytes);
  unknownAlignment.writeUInt32LE(0, 188);
  expect(() => readRustBinaryImage(unknownAlignment)).toThrow(
    /bytes after the zlib stream/u,
  );
});

it.each([1, 2])(
  "reads dependency metadata through ELF section-name compression %i",
  (compressionType) => {
    const image = readRustBinaryImage(
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

it("keeps dependency presence unknown for unsupported ELF name compression", () => {
  const image = readRustBinaryImage(
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

it("keeps dependency presence unknown when its ELF name offset is unreadable", () => {
  const bytes = createRustImage({ format: "elf" });
  bytes.writeUInt32LE(0xffff, 384);

  const image = readRustBinaryImage(bytes);
  expect(image.auditable_metadata).toBeNull();
  expect(image.section_names_limitation).toMatch(/outside its string table/u);
  expect(image.rustc_commit?.hashes).toEqual([
    { hash: RUSTC_HASH, file_offset: 2048 },
  ]);
});

it("finds rustc paths in read-only ELF load data without section headers", () => {
  const bytes = createRustImage({
    format: "elf",
    omitSection: true,
    includeRustc: true,
  });
  bytes.writeBigUInt64LE(0n, 40);
  bytes.writeUInt16LE(0, 60);
  bytes.writeUInt16LE(0, 62);
  bytes.writeUInt32LE(4, 132); // PF_R, no write or execute permission.

  expect(readRustBinaryImage(bytes)).toMatchObject({
    auditable_metadata: null,
    rustc_commit: {
      evidence_kind: "inferred",
      hashes: [{ hash: RUSTC_HASH, file_offset: 2048 }],
    },
  });

  bytes.writeUInt32LE(6, 132); // PF_R | PF_W is not read-only data.
  expect(readRustBinaryImage(bytes).rustc_commit).toBeNull();
});

const thrown = (read: () => unknown): unknown => {
  try {
    read();
  } catch (cause: unknown) {
    return cause;
  }
  throw new Error("expected a container failure");
};

it("refuses a universal Mach-O container", () => {
  const cause = thrown(() => readRustBinaryImage(fat([0x0100000c])));
  expect(cause).toBeInstanceOf(ParseFailureError);
  expect(cause).toMatchObject({
    failure: {
      kind: "unsupported",
      detail: expect.stringContaining("thin slice"),
    },
  });
});

it("keeps the container's truncated failure and its facts unchanged", () => {
  const bytes = createRustImage({ format: "elf" });
  // The fixture's first program header is at byte 128; p_filesz and
  // p_memsz are at +32 and +40.
  bytes.writeBigUInt64LE(BigInt(bytes.length) * 2n, 128 + 32);
  bytes.writeBigUInt64LE(BigInt(bytes.length) * 2n, 128 + 40);
  const container = thrown(() => readBinaryContainer(bytes, "elf-directory"));
  const rust = thrown(() => readRustBinaryImage(bytes));
  expect(rust).toBeInstanceOf(ParseFailureError);
  expect((rust as ParseFailureError).failure).toEqual(
    (container as ParseFailureError).failure,
  );
  expect((rust as ParseFailureError).failure).toMatchObject({
    kind: "truncated",
    format: "elf",
    offset: expect.any(Number),
    field: expect.any(String),
  });
});

it("does not read SHT_NOBITS dependency sections as stored bytes", () => {
  const bytes = createRustImage({ format: "elf" });
  // The fixture writes the .dep-v0 section header at byte 384.
  bytes.writeUInt32LE(8, 384 + 4);
  expect(thrown(() => readRustBinaryImage(bytes))).toMatchObject({
    failure: { kind: "malformed", format: "rust-auditable" },
  });
});

it("reads a rustc path from a read-only ELF section whose name exceeds 64 bytes", () => {
  const bytes = createRustImage({ format: "elf", omitSection: true });
  // omitSection places the rustc section header at 384 and shstrtab at 320.
  const nameOffset = bytes.readUInt32LE(384);
  const tableOffset = Number(bytes.readBigUInt64LE(320 + 24));
  const longName = Buffer.concat([Buffer.alloc(65, 0x61), Buffer.from([0])]);
  longName.copy(bytes, tableOffset + nameOffset);
  bytes.writeBigUInt64LE(BigInt(nameOffset + longName.length), 320 + 32);
  const image = readRustBinaryImage(bytes);
  expect(image.auditable_metadata).toBeNull();
  expect(image.rustc_commit).toEqual({
    evidence_kind: "inferred",
    hashes: [{ hash: RUSTC_HASH, file_offset: 2048 }],
  });
});

it("retains dependency facts when compiler paths exceed the selected prefix", () => {
  const bytes = createRustHashOverflowImage();
  const partial = readRustBinaryImage(bytes);
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
  const recovered = readRustBinaryImage(bytes, 65);
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
  (format, fault) => {
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
    expect(() => readGoBinaryImage(bytes)).toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/build-info|mapped/i),
        failure: expect.objectContaining({ kind: failureKind }),
      }),
    );
    expect(readRustBinaryImage(bytes)).toMatchObject({
      format,
      auditable_metadata: { file_offset: 1024, packages },
      rustc_commit: {
        evidence_kind: "inferred",
        hashes: [{ hash: RUSTC_HASH, file_offset: 2048 }],
      },
    });
  },
);

const positionalImage = (bytes: Buffer) => {
  const readRange = vi.fn(async (offset: number, length: number) =>
    Buffer.from(bytes.subarray(offset, offset + length)),
  );
  return {
    inspect: (maxHashes?: number, maxOutputBytes?: number) =>
      readRustBinaryImageFromHandle(
        { size: bytes.length, readRange },
        maxHashes,
        maxOutputBytes,
        async () => {},
      ),
    largestRead: () =>
      Math.max(...readRange.mock.calls.map(([, length]) => length)),
  };
};

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

it.each([true, false])(
  "bounds long WebAssembly name reads with valid UTF-8 set to %s",
  async (valid) => {
    const name = Buffer.alloc(1024 * 1024 + 32, 0x61);
    // Two-byte code point crossing the first name-read boundary.
    name[65535] = 0xc3;
    name[65536] = valid ? 0xa9 : 0x61;
    const image = positionalImage(
      Buffer.concat([
        WASM_MODULE_HEADER,
        wasmCustomSection(name, Buffer.alloc(0)),
        wasmCustomSection(".dep-v0", rustDependencyPayload()),
      ]),
    );
    if (valid) {
      expect((await image.inspect()).auditable_metadata).toMatchObject({
        packages,
      });
    } else {
      await expect(image.inspect()).rejects.toMatchObject({
        failure: {
          kind: "malformed",
          format: "wasm",
          field: "custom section name",
        },
      });
    }
    expect(image.largestRead()).toBeLessThanOrEqual(64 * 1024);
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
