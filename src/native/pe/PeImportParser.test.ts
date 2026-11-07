import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  inspectPeImportsInputSchema,
  peImportsSchema,
} from "../../domain/native/peImports.js";
import {
  peImportFixtureOffset,
  peImportImage,
  peImportLeadingSectionImage,
  peImportManySectionsImage,
  peImportDirectoryAtRva,
  peImportDirectoryMappingStops,
  peImportNameAtRva,
  peWithoutImportTableFixture,
} from "../../../tests/fixtures/binaryDiagnostics/peImports.js";
import { parsePeImports, PeImportLimitFailure } from "./PeImportParser.js";

const input = inspectPeImportsInputSchema.parse({
  path: "/artifacts/app.exe",
});

const artifact = (bytes: Buffer) => ({
  path: "/artifacts/app.exe",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
});

it("reads named PE32+ imports and a pefile-compatible import hash", async () => {
  const bytes = peImportImage({ bits: 64 });
  const report = await parsePeImports(bytes, artifact(bytes), input);
  expect(report.format).toBe("pe32-plus");
  expect(report.bits).toBe(64);
  expect(report.imports).toHaveLength(1);
  expect(report.imports[0]?.name).toBe("KERNEL32.dll");
  expect(report.imports[0]?.functions.map((row) => row.name)).toEqual([
    "GetProcAddress",
    "ExitProcess",
  ]);
  expect(report.imphash.md5).toBe("92cef6cc91a85825f3c8a0516517c66f");
  expect(report.coverage.status).toBe("complete");
  expect(report.delay_imports).toEqual([]);
});

const parse = (bytes: Buffer) => parsePeImports(bytes, artifact(bytes), input);

it.each([
  ["standard", 0],
  ["standard", 1],
  ["delay", 0],
  ["delay", 1],
] as const)(
  "retains %s rows before a descriptor mapping gap after %s rows",
  async (kind, retained) => {
    const report = await parse(peImportDirectoryMappingStops(kind, retained));
    const directory =
      kind === "standard"
        ? report.import_directory
        : report.delay_import_directory;
    const rows = kind === "standard" ? report.imports : report.delay_imports;
    const width = kind === "standard" ? 20 : 32;
    expect(rows).toHaveLength(retained);
    expect(directory).toMatchObject({
      rva: 0x40000000,
      locations: retained === 0 ? [] : [{ offset: 0x1000, bytes: width }],
    });
    expect(report.coverage.status).toBe("partial");
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "descriptor_unreadable",
        location: `0x${(0x40000000 + retained * width).toString(16)}`,
      }),
    );
    expect(report.imphash.md5).toBe(
      kind === "delay" ? "92cef6cc91a85825f3c8a0516517c66f" : null,
    );
    expect(peImportsSchema.safeParse(report).success).toBe(true);
  },
);

it.each([
  ["standard", 0xffffffec, 1, "0x100000000"],
  ["standard", 0xfffffff0, 0, "0xfffffff0"],
  ["delay", 0xffffffe0, 1, "0x100000000"],
  ["delay", 0xfffffff0, 0, "0xfffffff0"],
] as const)(
  "stops the %s descriptor walk at RVA %s",
  async (kind, rva, retained, invalid) => {
    const report = await parse(peImportDirectoryAtRva(kind, rva));
    const directory =
      kind === "standard"
        ? report.import_directory
        : report.delay_import_directory;
    const rows = kind === "standard" ? report.imports : report.delay_imports;
    expect(rows).toHaveLength(retained);
    expect(directory?.rva).toBe(rva);
    expect(directory?.locations).toHaveLength(retained);
    expect(report.coverage.status).toBe("partial");
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "malformed_entry", location: invalid }),
      ]),
    );
    expect(peImportsSchema.safeParse(report).success).toBe(true);
    expect(report.imphash.md5).toBe(
      kind === "delay" ? "92cef6cc91a85825f3c8a0516517c66f" : null,
    );
  },
);

it("does not consume a DLL name past the uint32 RVA end", async () => {
  const report = await parse(peImportNameAtRva(0xfffffff8));
  expect(report.imports[0]?.name).toBeNull();
  expect(report.imports[0]?.functions).toHaveLength(2);
  expect(report.coverage).toMatchObject({
    status: "partial",
    reason:
      "1 import table issue(s) affect reported rows or metadata; see issues",
  });
  expect(report.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "name_unreadable",
        location: "0xfffffff8",
      }),
    ]),
  );
  expect(report.imphash.md5).toBeNull();
});

it("accepts a DLL name whose NUL is the final uint32 RVA byte", async () => {
  const report = await parse(peImportNameAtRva(0xfffffff3));
  expect(report.imports[0]?.name).toBe("KERNEL32.dll");
  expect(report.coverage.status).toBe("complete");
  expect(report.imphash.md5).toBe("92cef6cc91a85825f3c8a0516517c66f");
});

it.each([
  [0x8000000100000001n, "72d9cd67504bb3b9f29c37a226bf4331"],
  [0x8000000000010001n, null],
  [0x8000000000000001n, "72d9cd67504bb3b9f29c37a226bf4331"],
] as const)(
  "matches pefile 2024.8.26 for ordinal thunk %s",
  async (thunk, expected) => {
    const bytes = peImportImage();
    for (const rva of [0x1028, 0x1040])
      bytes.writeBigUInt64LE(thunk, peImportFixtureOffset(rva));
    const report = await parse(bytes);
    expect(report.imports[0]?.functions[0]).toMatchObject({
      ordinal: 1,
      thunk_hex: thunk.toString(16),
    });
    expect(report.imphash.md5).toBe(expected);
  },
);

it("withholds the hash beyond pefile's section parser capacity", async () => {
  const report = await parse(peImportManySectionsImage(2049, 2));
  expect(report.imports[0]?.functions.map((row) => row.name)).toEqual([
    "Function0000",
    "Function0001",
  ]);
  expect(report.coverage.status).toBe("complete");
  expect(report.imphash.md5).toBeNull();
  expect(report.imphash.reason).toMatch(/mapping|compatibility/u);
});

it.each([false, true])(
  "withholds the hash when pefile stops at an earlier section (suspicious: %s)",
  async (suspicious) => {
    const report = await parse(peImportLeadingSectionImage(suspicious));
    expect(report.imports[0]?.functions.map((row) => row.name)).toEqual([
      "GetProcAddress",
      "ExitProcess",
    ]);
    expect(report.coverage.status).toBe("complete");
    expect(report.imphash.md5).toBeNull();
    expect(report.imphash.reason).toMatch(/mapping|compatibility/u);
  },
);

/** Default PE32+ KERNEL32 image with one descriptor field rewritten. */
const withDescriptorField = (
  field: number,
  value: number,
  options: Parameters<typeof peImportImage>[0] = {},
) => {
  const bytes = peImportImage(options);
  bytes.writeUInt32LE(value, peImportFixtureOffset(0x1000) + field);
  return bytes;
};

it("hashes unmapped ordinals as pefile's ord<decimal> fallback", async () => {
  const bytes = peImportImage({
    bits: 32,
    dlls: [
      {
        name: "USER32.dll",
        functions: [{ ordinal: 42 }],
      },
    ],
  });
  const report = await parsePeImports(bytes, artifact(bytes), input);
  expect(report.format).toBe("pe32");
  expect(report.imports[0]?.functions[0]).toMatchObject({
    name: null,
    ordinal: 42,
    hint: null,
  });
  // pefile 2024.8.26 get_imphash() over this image: MD5("user32.ord42").
  expect(report.imphash).toEqual({
    algorithm: "pefile",
    md5: "f39f7ee67c122319a74d4270d3e5c36c",
    reason: null,
  });
});

it("falls back to ord<decimal> for DLL names that shadow object members", async () => {
  const bytes = peImportImage({
    bits: 32,
    dlls: [
      { name: "constructor", functions: [{ ordinal: 1 }] },
      { name: "__proto__", functions: [{ ordinal: 2 }] },
    ],
  });
  // pefile: "constructor.ord1,__proto__.ord2".
  expect((await parse(bytes)).imphash).toEqual({
    algorithm: "pefile",
    md5: "8a4fd3988e11f8e29b11a7edc60886e6",
    reason: null,
  });
});

it("uses pefile's complete ws2_32 and wsock32 ordinal tables", async () => {
  const bytes = peImportImage({
    bits: 32,
    dlls: [
      {
        name: "WS2_32.dll",
        functions: [{ ordinal: 23 }, { ordinal: 999 }, { name: "WSAStartup" }],
      },
      { name: "wsock32.dll", functions: [{ ordinal: 1155 }, { ordinal: 1 }] },
    ],
  });
  // pefile: "ws2_32.socket,ws2_32.ord999,ws2_32.wsastartup,wsock32.ord1155,wsock32.accept".
  expect((await parse(bytes)).imphash.md5).toBe(
    "79b3bdee998e474e75390fac55093cb0",
  );
});

it("withholds the import hash when a standard import name is unreadable", async () => {
  const bytes = peImportImage();
  const lookup = (await parse(bytes)).imports[0]?.original_first_thunk_rva ?? 0;
  bytes.writeBigUInt64LE(0x7fff0000n, peImportFixtureOffset(lookup + 8));
  const report = await parse(bytes);
  expect(report.imports[0]?.functions.map((row) => row.name)).toEqual([
    "GetProcAddress",
  ]);
  expect(report.issues).toMatchObject([
    { code: "name_unreadable", location: "0x7fff0000" },
  ]);
  expect(report.coverage.status).toBe("partial");
  expect(report.imphash.md5).toBeNull();
  expect(report.imphash.reason).toMatch(/standard import table is incomplete/u);
});

it("withholds the import hash when a standard thunk is unreadable", async () => {
  const bytes = withDescriptorField(0, 0x7fff0000);
  const report = await parse(bytes);
  expect(report.imports[0]?.functions).toEqual([]);
  expect(report.issues[0]?.code).toBe("thunk_unreadable");
  expect(report.coverage.status).toBe("partial");
  expect(report.imphash.md5).toBeNull();
});

it("reports a zero FirstThunk beside a populated lookup table as malformed", async () => {
  const report = await parse(withDescriptorField(16, 0));
  expect(report.imports[0]).toMatchObject({
    name: "KERNEL32.dll",
    first_thunk_rva: 0,
    functions: [],
  });
  expect(report.issues).toMatchObject([
    { code: "malformed_entry", message: expect.stringMatching(/FirstThunk/u) },
  ]);
  expect(report.coverage.status).toBe("partial");
  expect(report.imphash.md5).toBeNull();
  expect(report.imphash.reason).toMatch(/incomplete/u);
});

it.each([
  ["import address table", 12],
  ["import name table", 16],
])(
  "reports a delay-load descriptor with a zero %s as malformed without withholding the standard hash",
  async (table, field) => {
    const bytes = peImportImage({
      delayDlls: [
        { name: "ADVAPI32.dll", functions: [{ name: "RegOpenKeyExW" }] },
      ],
    });
    const location = (await parse(bytes)).delay_imports[0]?.location;
    if (location === undefined) throw new Error("Expected a delay descriptor");
    bytes.writeUInt32LE(0, location.offset + field);
    const report = await parse(bytes);
    expect(report.delay_imports[0]?.functions).toEqual([]);
    expect(report.issues).toMatchObject([
      {
        code: "malformed_entry",
        message: expect.stringContaining(`zero ${table} RVA`),
      },
    ]);
    expect(report.coverage.status).toBe("partial");
    expect(report.imphash.md5).toBe("92cef6cc91a85825f3c8a0516517c66f");
  },
);

it("reports each discontiguous file span a descriptor array consumes", async () => {
  const options = {
    delayDlls: [
      { name: "ADVAPI32.dll", functions: [{ name: "RegOpenKeyExW" }] },
    ],
  };
  const whole = await parse(peImportImage(options));
  expect(whole.import_directory?.locations).toEqual([
    { offset: 0x400, bytes: 40 },
  ]);
  expect(whole.delay_import_directory?.locations).toEqual([
    { offset: 0x428, bytes: 64 },
  ]);
  // Second section bytes move to file offset 0x400 + 0x800 + 0x200.
  const importSplit = await parse(peImportImage({ ...options, splitAt: 20 }));
  expect(importSplit.import_directory?.locations).toEqual([
    { offset: 0x400, bytes: 20 },
    { offset: 0xe00, bytes: 20 },
  ]);
  expect(importSplit.delay_import_directory?.locations).toEqual([
    { offset: 0xe14, bytes: 64 },
  ]);
  const delaySplit = await parse(peImportImage({ ...options, splitAt: 72 }));
  expect(delaySplit.import_directory?.locations).toEqual([
    { offset: 0x400, bytes: 40 },
  ]);
  expect(delaySplit.delay_import_directory?.locations).toEqual([
    { offset: 0x428, bytes: 32 },
    { offset: 0xe00, bytes: 32 },
  ]);
  for (const report of [importSplit, delaySplit]) {
    expect(report.coverage.status).toBe("complete");
    expect(report.imports[0]?.functions.map((row) => row.name)).toEqual([
      "GetProcAddress",
      "ExitProcess",
    ]);
    expect(report.delay_imports[0]?.functions[0]?.name).toBe("RegOpenKeyExW");
    expect(report.imphash.md5).toBe("92cef6cc91a85825f3c8a0516517c66f");
  }
});

it.each([
  [
    "a function name pefile treats as invalid",
    { name: "Get-Proc" },
    /invalid/u,
  ],
  ["ordinal 0", { ordinal: 0 }, /ordinal 0/u],
  [
    "a name reaching pefile's read limit",
    { name: "A".repeat(512) },
    /512-byte read limit/u,
  ],
] as const)(
  "withholds the import hash for %s rather than diverge from pefile",
  async (_label, entry, reason) => {
    const report = await parse(
      peImportImage({
        sectionBytes: 0x1000,
        dlls: [{ name: "KERNEL32.dll", functions: [entry] }],
      }),
    );
    expect(report.coverage.status).toBe("complete");
    expect(report.imphash.md5).toBeNull();
    expect(report.imphash.reason).toMatch(reason);
  },
);

it.each([511, 512, 513])(
  "retains a %i-byte function name and explains the pefile read boundary",
  async (length) => {
    const name = "A".repeat(length);
    const report = await parse(
      peImportImage({
        sectionBytes: 0x1000,
        dlls: [{ name: "k.dll", functions: [{ name }] }],
      }),
    );
    expect(report.coverage.status).toBe("complete");
    expect(report.imports[0]?.functions[0]?.name).toBe(name);
    if (length === 511) {
      expect(report.imphash.md5).toBe("897726129e4219bdf7853234ba4eeb69");
      expect(report.imphash.reason).toBeNull();
    } else {
      expect(report.imphash.md5).toBeNull();
      expect(report.imphash.reason).toContain("512-byte read limit");
      expect(report.imphash.reason).toContain("truncated name");
    }
  },
);

it("describes the same bounded read for a long DLL name", async () => {
  const name = `${"A".repeat(513)}.dll`;
  const report = await parse(
    peImportImage({
      sectionBytes: 0x1000,
      dlls: [{ name, functions: [{ name: "ExitProcess" }] }],
    }),
  );
  expect(report.imports[0]?.name).toBe(name);
  expect(report.imphash.md5).toBeNull();
  expect(report.imphash.reason).toContain(
    "DLL name reaches pefile's 512-byte read limit",
  );
});

it("reads delay-load descriptors separately from the import hash", async () => {
  const bytes = peImportImage({
    delayDlls: [
      {
        name: "ADVAPI32.dll",
        functions: [{ name: "RegOpenKeyExW", hint: 3 }],
      },
    ],
  });
  const report = await parsePeImports(bytes, artifact(bytes), input);
  expect(report.delay_imports).toHaveLength(1);
  expect(report.delay_imports[0]?.name).toBe("ADVAPI32.dll");
  expect(report.delay_imports[0]?.functions[0]?.name).toBe("RegOpenKeyExW");
  expect(report.imphash.md5).toBe("92cef6cc91a85825f3c8a0516517c66f");
});

it("reports an image without an import directory as importing nothing", async () => {
  const bytes = peWithoutImportTableFixture();
  const report = await parsePeImports(bytes, artifact(bytes), input);
  expect(report.import_directory).toBeNull();
  expect(report.imports).toEqual([]);
  expect(report.coverage.status).toBe("complete");
  expect(report.limitations[0]).toContain(
    "IMAGE_DIRECTORY_ENTRY_IMPORT is absent",
  );
});

it("fails closed when the DLL budget is exhausted", async () => {
  const bytes = peImportImage({
    dlls: [
      { name: "A.dll", functions: [{ name: "a" }] },
      { name: "B.dll", functions: [{ name: "b" }] },
    ],
  });
  await expect(
    parsePeImports(
      bytes,
      artifact(bytes),
      inspectPeImportsInputSchema.parse({
        path: "/artifacts/app.exe",
        max_dlls: 1,
      }),
    ),
  ).rejects.toThrow(
    expect.objectContaining({ limit: "dlls", maximum_bytes: 1 }),
  );
});

it("fails closed when the function budget is exhausted", async () => {
  const bytes = peImportImage({
    dlls: [
      {
        name: "KERNEL32.dll",
        functions: [{ name: "GetProcAddress" }, { name: "ExitProcess" }],
      },
    ],
  });
  await expect(
    parsePeImports(
      bytes,
      artifact(bytes),
      inspectPeImportsInputSchema.parse({
        path: "/artifacts/app.exe",
        max_functions: 1,
      }),
    ),
  ).rejects.toThrow(
    expect.objectContaining({ limit: "functions", maximum_bytes: 1 }),
  );
});

it("fails closed with a structured tag when retained name text is exhausted", async () => {
  const name = "A".repeat(4096);
  const bytes = peImportImage({
    sectionBytes: 0x1200000,
    dlls: [
      {
        name: "KERNEL32.dll",
        functions: Array.from({ length: 4097 }, () => ({ name })),
      },
    ],
  });
  const failure = parse(bytes);
  await expect(failure).rejects.toThrow(PeImportLimitFailure);
  await expect(failure).rejects.toThrow(
    expect.objectContaining({
      limit: "retained_text",
      maximum_bytes: 16 * 1024 * 1024,
    }),
  );
});

it("computes a pefile import hash for oleaut32 ordinal names", async () => {
  const bytes = peImportImage({
    dlls: [
      {
        name: "OLEAUT32.dll",
        functions: [{ ordinal: 2 }],
      },
    ],
  });
  const report = await parsePeImports(bytes, artifact(bytes), input);
  expect(report.imports[0]?.functions[0]).toMatchObject({
    name: null,
    ordinal: 2,
  });
  expect(report.imphash.md5).toBe("3dc76082b322e4bf41120e4657c7f5c6");
});

it("records PE32+ delay-load virtual-address descriptors as unsupported", async () => {
  const bytes = peImportImage({
    delayDlls: [
      {
        name: "ADVAPI32.dll",
        functions: [{ name: "RegOpenKeyExW" }],
      },
    ],
    delayAttributes: 0,
  });
  const report = await parsePeImports(bytes, artifact(bytes), input);
  expect(report.delay_imports).toEqual([]);
  expect(report.coverage.status).toBe("partial");
  expect(report.issues[0]?.code).toBe("unsupported_form");
  expect(report.imphash.md5).toBe("92cef6cc91a85825f3c8a0516517c66f");
});

it("withholds the import hash exactly where pefile's import symbol cap truncates", async () => {
  const image = (sizes: readonly number[]) =>
    peImportImage({
      sectionBytes: 0x100000,
      dlls: sizes.map((count, dll) => ({
        name: `D${String(dll)}.dll`,
        functions: Array.from({ length: count }, (_, index) => ({
          name: `F${String(dll)}_${String(index)}`,
        })),
      })),
    });
  // pefile 2024.8.26 hashes all 4096 rows here...
  expect((await parse(image([4095, 1]))).imphash.md5).toBe(
    "2217c72699a462a8ca9980afe6a852aa",
  );
  // ...but drops D1.dll here because its 8192-thunk cap is reached first.
  const capped = await parse(image([4096, 1]));
  expect(capped.coverage.status).toBe("complete");
  expect(capped.imphash.md5).toBeNull();
  expect(capped.imphash.reason).toMatch(/descriptor 1 .*symbol cap/u);
});

it("yields during long table walks and stops when the caller cancels", async () => {
  const bytes = peImportImage({
    sectionBytes: 0x20000,
    dlls: [
      {
        name: "KERNEL32.dll",
        functions: Array.from({ length: 4000 }, (_, index) => ({
          name: `F${String(index)}`,
        })),
      },
    ],
  });
  const controller = new AbortController();
  const pending = parsePeImports(
    bytes,
    artifact(bytes),
    input,
    controller.signal,
  );
  let ticks = 0;
  const tick = setImmediate(() => {
    ticks += 1;
    controller.abort();
  });
  await expect(pending).rejects.toMatchObject({
    name: "ArtifactReaderFailure",
    reason: "cancelled",
  });
  clearImmediate(tick);
  expect(ticks).toBe(1);
});

it("withholds the import hash once pefile would discard a repetitive lookup table", async () => {
  const repeated = async (repeats: number) => {
    const bytes = peImportImage({
      dlls: [
        {
          name: "KERNEL32.dll",
          functions: Array.from({ length: repeats + 1 }, (_, index) => ({
            name: `F${String(index)}`,
          })),
        },
      ],
    });
    const lookup = (await parse(bytes)).imports[0]?.original_first_thunk_rva;
    if (lookup === undefined) throw new Error("Expected a lookup table");
    const first = bytes.readBigUInt64LE(peImportFixtureOffset(lookup));
    for (let index = 1; index <= repeats; index++)
      bytes.writeBigUInt64LE(first, peImportFixtureOffset(lookup + index * 8));
    return parse(bytes);
  };
  // pefile 2024.8.26 keeps 14 repeats and hashes the lookup rows...
  expect((await repeated(14)).imphash.md5).toBe(
    "a849c88f8733c2f2171c4130e925bca6",
  );
  // ...but discards the table at 15 and hashes the import address table instead.
  const discarded = await repeated(15);
  expect(discarded.coverage.status).toBe("complete");
  expect(discarded.imphash.md5).toBeNull();
  expect(discarded.imphash.reason).toMatch(/repeats hint\/name addresses 15/u);
});

it.each([32, 64] as const)(
  "retains valid rows before a PE%s IAT RVA overflows",
  async (bits) => {
    const width = bits / 8;
    const bytes = withDescriptorField(16, 0x100000000 - width, { bits });
    const report = await parse(bytes);
    expect(peImportsSchema.safeParse(report).success).toBe(true);
    expect(report.imports[0]?.functions).toHaveLength(1);
    expect(report.imports[0]?.functions[0]?.iat_rva).toBe(0x100000000 - width);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "malformed_entry",
          location: "0x100000000",
        }),
      ]),
    );
    expect(report.coverage.status).toBe("partial");
    expect(report.imphash.md5).toBeNull();
  },
);

it("preserves an invalid wide named thunk without rounding its source value", async () => {
  const bytes = peImportImage();
  bytes.writeBigUInt64LE(0x20000000000001n, peImportFixtureOffset(0x1028));
  const report = await parse(bytes);
  expect(report.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "malformed_entry",
        location: "0x20000000000001",
      }),
    ]),
  );
  expect(report.imports[0]?.functions.map((row) => row.name)).toEqual([
    "ExitProcess",
  ]);
  expect(report.coverage.status).toBe("partial");
  expect(report.imphash.md5).toBeNull();
});

it.each(["function", "DLL"])(
  "retains a cross-section %s name but withholds an unproven pefile hash",
  async (kind) => {
    const count = kind === "function" ? 140 : 134;
    const functions = Array.from({ length: count }, (_, i) => ({
      name: `Function${String(i).padStart(3, "0")}${kind === "DLL" && i === 0 ? "A".repeat(10) : ""}`,
    }));
    const bytes = peImportImage({
      sectionBytes: 0x4000,
      splitAt: 0x1000,
      dlls: [{ name: "KERNEL32.dll", functions }],
    });
    const report = await parse(bytes);
    expect(report.imports[0]?.name).toBe("KERNEL32.dll");
    expect(report.imports[0]?.functions.map((row) => row.name)).toEqual(
      functions.map((row) => row.name),
    );
    expect(report.coverage.status).toBe("complete");
    expect(report.imphash.md5).toBeNull();
    expect(report.imphash.reason).toMatch(/mapping|compatibility/u);
  },
);

const legacyDelayImage = () =>
  peImportImage({
    bits: 32,
    delayVirtualAddresses: true,
    delayDlls: [
      {
        name: "ADVAPI32.dll",
        functions: [{ name: "RegOpenKeyExW", hint: 7 }, { ordinal: 12 }],
      },
    ],
  });
const legacyDescriptorOffset = (bytes: Buffer) =>
  peImportFixtureOffset(bytes.readUInt32LE(152 + 96 + 13 * 8));

it("decodes PE32 delay VAs into RVAs while preserving raw thunks and standard imports", async () => {
  const bytes = legacyDelayImage();
  const at = legacyDescriptorOffset(bytes);
  const base = 0x10000000;
  for (const offset of [8, 20, 24])
    bytes.writeUInt32LE(base + 0x1700 + offset, at + offset);
  const report = peImportsSchema.parse(await parse(bytes));
  const dll = report.delay_imports[0];
  expect(dll).toMatchObject({
    name: "ADVAPI32.dll",
    attributes: 0,
    name_rva: bytes.readUInt32LE(at + 4) - base,
    import_address_table_rva: bytes.readUInt32LE(at + 12) - base,
    import_name_table_rva: bytes.readUInt32LE(at + 16) - base,
    module_handle_rva: 0x1708,
    bound_import_rva: 0x1714,
    unload_information_table_rva: 0x1718,
    location: { offset: at, bytes: 32 },
  });
  const intRva = bytes.readUInt32LE(at + 16) - base;
  expect(dll?.functions).toMatchObject([
    {
      name: "RegOpenKeyExW",
      hint: 7,
      ordinal: null,
      ilt_rva: intRva,
      thunk_hex: bytes.readUInt32LE(peImportFixtureOffset(intRva)).toString(16),
    },
    { name: null, ordinal: 12, thunk_hex: "8000000c" },
  ]);
  expect(report.coverage).toMatchObject({
    status: "complete",
    imports: 2,
    delay_imports: 2,
  });
  expect(report.imphash.md5).toBe("92cef6cc91a85825f3c8a0516517c66f");
});

it.each([
  [4, "name_rva"],
  [8, "module_handle_rva"],
  [12, "import_address_table_rva"],
  [16, "import_name_table_rva"],
  [20, "bound_import_rva"],
  [24, "unload_information_table_rva"],
] as const)(
  "retains readable facts after an invalid legacy address at field %s",
  async (field, name) => {
    const bytes = legacyDelayImage();
    bytes.writeUInt32LE(0x1000, legacyDescriptorOffset(bytes) + field);
    const report = await parse(bytes);
    const dll = report.delay_imports[0];
    expect(dll?.[name]).toBeNull();
    expect(dll?.name).toBe(field === 4 ? null : "ADVAPI32.dll");
    expect(dll?.functions.map((f) => f.name ?? f.ordinal)).toEqual(
      field === 12 || field === 16 ? [] : ["RegOpenKeyExW", 12],
    );
    expect(peImportsSchema.safeParse(report).success).toBe(true);
    expect(report.coverage.status).toBe("partial");
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "malformed_entry",
        message: expect.stringContaining("below the image base"),
      }),
    );
    expect(report.imphash.md5).toBe("92cef6cc91a85825f3c8a0516517c66f");
  },
);

it("retains ordinal imports after an invalid legacy named thunk", async () => {
  const bytes = legacyDelayImage();
  const intRva =
    bytes.readUInt32LE(legacyDescriptorOffset(bytes) + 16) - 0x10000000;
  bytes.writeUInt32LE(0x1000, peImportFixtureOffset(intRva));
  const report = await parse(bytes);
  expect(report.delay_imports[0]?.functions).toMatchObject([{ ordinal: 12 }]);
  expect(report.coverage.status).toBe("partial");
  expect(report.issues[0]).toMatchObject({
    code: "malformed_entry",
    location: "0x1000",
  });
});

it.each([12, 16])(
  "preserves missing legacy table fields at offset %s",
  async (field) => {
    const bytes = legacyDelayImage();
    bytes.writeUInt32LE(0, legacyDescriptorOffset(bytes) + field);
    const report = await parse(bytes);
    expect(report.delay_imports[0]).toMatchObject({
      name: "ADVAPI32.dll",
      functions: [],
      module_handle_rva: 0,
      bound_import_rva: 0,
      unload_information_table_rva: 0,
    });
    expect(report.coverage.status).toBe("partial");
    expect(report.issues[0]?.code).toBe("malformed_entry");
  },
);

it("charges decoded legacy thunks against the shared function budget", async () => {
  const bytes = legacyDelayImage();
  await expect(
    parsePeImports(bytes, artifact(bytes), { ...input, max_functions: 3 }),
  ).rejects.toThrow(PeImportLimitFailure);
});

it("keeps independent address failures and readable imports in the same descriptor", async () => {
  const bytes = legacyDelayImage();
  const at = legacyDescriptorOffset(bytes);
  for (const offset of [8, 20, 24]) bytes.writeUInt32LE(0x1000, at + offset);
  const report = peImportsSchema.parse(await parse(bytes));
  expect(report.delay_imports[0]).toMatchObject({
    name: "ADVAPI32.dll",
    module_handle_rva: null,
    bound_import_rva: null,
    unload_information_table_rva: null,
  });
  expect(report.delay_imports[0]?.functions).toHaveLength(2);
  expect(report.issues).toHaveLength(3);
  expect(new Set(report.issues.map((issue) => issue.location)).size).toBe(3);
});
