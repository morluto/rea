import { expect, it } from "vitest";
import { ParseFailureError } from "../../domain/parseFailure.js";
import {
  inspectElfDependenciesInputSchema,
  elfDependenciesSchema,
  MAX_INSPECT_ELF_DEPENDENCY_IMPORTS,
} from "../../domain/native/elfDependencies.js";
import { BinaryFormatFailure } from "../../domain/binaryContainer.js";
import { readElfDependencies } from "../../domain/desktop/elfDependencies.js";
import { readElfHardening } from "../hardening/ElfHardening.js";
import { elfDependencyFixture, elfHash } from "./ElfDependencies.fixture.js";
import { readElfDependenciesSteps } from "./ElfDependencyParser.js";

const parseElfDependencies = (
  ...arguments_: Parameters<typeof readElfDependenciesSteps>
) => {
  const steps = readElfDependenciesSteps(...arguments_);
  for (let next = steps.next(); ; next = steps.next())
    if (next.done) return next.value;
};

const artifactPath = "/artifacts/program";

const parse = (
  bytes: Buffer,
  extra: {
    readonly max_needed?: number;
    readonly max_versions?: number;
    readonly max_imports?: number;
  } = {},
) =>
  elfDependenciesSchema.parse(
    parseElfDependencies(
      bytes,
      {
        path: artifactPath,
        sha256: "ab".repeat(32),
        bytes: bytes.length,
      },
      inspectElfDependenciesInputSchema.parse({
        path: artifactPath,
        ...extra,
      }),
    ),
  );

const defaultNeeded = ["libstdc++.so.6", "libm.so.6", "libc.so.6"];

it.each([
  { bits: 32, little: false },
  { bits: 64, little: true },
] as const)(
  "reports a partial PT_DYNAMIC row in ELF$bits without discarding earlier dependencies",
  async ({ bits, little }) => {
    const width = bits === 64 ? 16 : 8;
    for (const extra of [width, 1, 1 - width]) {
      const bytes = elfDependencyFixture({
        bits,
        little,
        stripped: true,
        interpreter: null,
        dynamicTailBytes: extra,
      });
      const report = parse(bytes);
      expect(report.needed.map(({ name }) => name)).toEqual(defaultNeeded);
      const desktop = await readElfDependencies(
        async (offset, size) => bytes.subarray(offset, offset + size),
        bytes.length,
      );
      if (extra === width) {
        expect(report.coverage.status).toBe("complete");
        expect(desktop).toMatchObject({
          ok: true,
          value: { needed: defaultNeeded },
        });
        expect(readElfHardening(bytes).format).toBe("elf");
      } else {
        expect(report.coverage.status).toBe("partial");
        expect(report.issues).toContainEqual({
          code: "malformed_entry",
          // PT_DYNAMIC is the final payload of the stripped fixture.
          location: `0x${(bytes.length - 1).toString(16)}`,
          message: "ELF PT_DYNAMIC size is not a whole number of entries",
        });
        expect(desktop).toMatchObject({
          ok: false,
          error: {
            kind: "unreadable",
            reason: "ELF PT_DYNAMIC size is not a whole number of entries",
          },
        });
        expect(() => readElfHardening(bytes)).toThrow(
          "ELF PT_DYNAMIC size is not a whole number of entries",
        );
      }
    }
  },
);

const elf64ProgramHeaders = (original: Buffer) => {
  const phoff = Number(original.readBigUInt64LE(32));
  const phentsize = original.readUInt16LE(54);
  const phnum = original.readUInt16LE(56);
  const programHeaders = Array.from(
    { length: phnum },
    (_, index) => phoff + index * phentsize,
  );
  return { phoff, phentsize, phnum, programHeaders };
};

const elf64DynamicTags = (original: Buffer, headers: readonly number[]) => {
  const dynamic = headers.find((offset) => original.readUInt32LE(offset) === 2);
  if (dynamic === undefined) throw new Error("Expected PT_DYNAMIC");
  const start = Number(original.readBigUInt64LE(dynamic + 8));
  const count = Number(original.readBigUInt64LE(dynamic + 32)) / 16;
  return new Map(
    Array.from({ length: count }, (_, index) => {
      const offset = start + index * 16;
      return [
        original.readBigInt64LE(offset),
        original.readBigUInt64LE(offset + 8),
      ];
    }),
  );
};

const shortenElf64IdentityLoad = (
  original: Buffer,
  bytes: Buffer,
  { phoff, programHeaders }: ReturnType<typeof elf64ProgramHeaders>,
  end: bigint,
) => {
  const load = programHeaders.find(
    (offset) => original.readUInt32LE(offset) === 1,
  );
  if (load === undefined) throw new Error("Expected PT_LOAD");
  const movedLoad = original.length + load - phoff;
  bytes.writeBigUInt64LE(end, movedLoad + 32);
  bytes.writeBigUInt64LE(end, movedLoad + 40);
};

const appendElf64ZeroFill = (
  original: Buffer,
  { phoff, phentsize, phnum }: ReturnType<typeof elf64ProgramHeaders>,
) => {
  const bytes = Buffer.concat([
    original,
    Buffer.alloc((phnum + 1) * phentsize),
  ]);
  original.copy(bytes, original.length, phoff, phoff + phnum * phentsize);
  bytes.writeBigUInt64LE(BigInt(original.length), 32);
  bytes.writeUInt16LE(phnum + 1, 56);
  const alias = original.length + phnum * phentsize;
  bytes.writeUInt32LE(1, alias);
  bytes.writeUInt32LE(4, alias + 4);
  bytes.writeBigUInt64LE(1n, alias + 40);
  bytes.writeBigUInt64LE(1n, alias + 48);
  return { bytes, alias };
};

it.each([
  { stripped: true, unmappedTail: false },
  { stripped: false, unmappedTail: false },
  { stripped: false, unmappedTail: true },
])(
  "leaves dynamic strings unknown on a zero-fill overlap (stripped: $stripped, unmapped tail: $unmappedTail)",
  ({ stripped, unmappedTail }) => {
    const original = elfDependencyFixture({ bits: 64, little: true, stripped });
    const headers = elf64ProgramHeaders(original);
    const tags = elf64DynamicTags(original, headers.programHeaders);
    const stringAddress = tags.get(5n);
    const stringSize = tags.get(10n);
    if (stringAddress === undefined || stringSize === undefined)
      throw new Error("Expected DT_STRTAB and DT_STRSZ");
    const { bytes, alias } = appendElf64ZeroFill(original, headers);
    if (unmappedTail)
      // The table starts in the identity mapping, but its section alone describes the tail.
      shortenElf64IdentityLoad(original, bytes, headers, stringAddress + 2n);
    bytes.writeBigUInt64LE(stringAddress + stringSize, alias + 16);
    expect(parse(bytes).needed.map(({ name }) => name)).toEqual(defaultNeeded);

    // The initial NUL byte still maps uniquely; a later string byte does not.
    bytes.writeBigUInt64LE(stringAddress + 1n, alias + 16);
    const report = parse(bytes);
    expect(report.needed.map(({ name }) => name)).toEqual([null, null, null]);
    expect(report.coverage.status).toBe("partial");
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "table_unavailable",
        message: "ELF dynamic string table has ambiguous file mappings",
      }),
    );
  },
);

it.each([false, true])(
  "keeps independent dependency names when dynamic symbol bytes disagree (string table gap: %s)",
  (stringGap) => {
    const original = elfDependencyFixture();
    const headers = elf64ProgramHeaders(original);
    const tags = elf64DynamicTags(original, headers.programHeaders);
    const symtab = tags.get(6n);
    const strtab = tags.get(5n);
    if (symtab === undefined || strtab === undefined)
      throw new Error("Expected DT_SYMTAB and DT_STRTAB");
    const { bytes, alias } = appendElf64ZeroFill(original, headers);
    if (stringGap)
      shortenElf64IdentityLoad(original, bytes, headers, strtab + 2n);
    bytes.writeBigUInt64LE(BigInt(original.length), alias + 16);
    expect(parse(bytes).imports.map(({ name }) => name)).toEqual([
      "printf",
      "memcpy",
      "_ZSt4cout",
      "abort",
      "_exit",
    ]);

    // The symbol table start stays mapped; a later symbol occupies both kinds of storage.
    bytes.writeBigUInt64LE(symtab + 24n, alias + 16);
    const report = parse(bytes);
    expect(report.needed.map(({ name }) => name)).toEqual(defaultNeeded);
    expect(report.imports).toEqual([]);
    expect(report.coverage.status).toBe("partial");
  },
);

/** The version_unresolved issue a GNU version table reports at its own offset. */
const versionTableIssue = (table: {
  readonly location: { readonly offset: number } | null;
}) => {
  if (table.location === null)
    throw new Error("Expected a version table range");
  return expect.objectContaining({
    code: "version_unresolved",
    location: `0x${table.location.offset.toString(16)}`,
  });
};

it.each([
  [64, true],
  [32, false],
] as const)(
  "reports DT_NEEDED, RUNPATH tokens, GNU versions, and imports for ELF%s %s",
  (bits, little) => {
    const report = parse(elfDependencyFixture({ bits, little }));
    expect(report).toMatchObject({
      format: bits === 64 ? "elf64" : "elf32",
      byte_order: little ? "little" : "big",
      machine: bits === 64 ? 62 : 8,
      architecture: bits === 64 ? "amd64" : "mips",
      type: 3,
      type_name: "shared",
      interpreter: {
        status: "present",
        path:
          bits === 64 ? "/lib64/ld-linux-x86-64.so.2" : "/lib/ld-linux.so.2",
      },
      dynamic: {
        status: "present",
        soname: { name: "libdemo.so.1" },
        runpath: {
          raw: "$ORIGIN/../lib",
          entries: ["$ORIGIN/../lib"],
          tokens: ["$ORIGIN"],
        },
        flags: { raw: 0x9, names: ["ORIGIN", "BIND_NOW"], unrecognized: 0 },
        flags_1: {
          raw: 0x08000881,
          names: ["NOW", "ORIGIN", "NODEFLIB", "PIE"],
          unrecognized: 0,
        },
      },
      coverage: { status: "complete", examined_needed: 3, examined_imports: 5 },
      issues: [],
    });
    expect(report.needed.map((entry) => [entry.index, entry.name])).toEqual(
      defaultNeeded.map((name, index) => [index, name]),
    );
    expect(
      report.version_requirements.files.map((file) => [
        file.file,
        file.versions.map((version) => [
          version.name,
          version.index,
          version.hash,
          version.flags.weak,
        ]),
      ]),
    ).toEqual([
      [
        "libc.so.6",
        [
          ["GLIBC_2.2.5", 2, elfHash("GLIBC_2.2.5"), false],
          ["GLIBC_2.34", 3, elfHash("GLIBC_2.34"), false],
        ],
      ],
      [
        "libstdc++.so.6",
        [["GLIBCXX_3.4.29", 4, elfHash("GLIBCXX_3.4.29"), false]],
      ],
    ]);
    expect(report.version_definitions.names).toEqual([
      { name: "libdemo.so.1", index: 1, base: true },
    ]);
    expect(report.derived_version_maxima).toEqual([
      { namespace: "GLIBC", maximum: "GLIBC_2.34", evidence_kind: "derived" },
      {
        namespace: "GLIBCXX",
        maximum: "GLIBCXX_3.4.29",
        evidence_kind: "derived",
      },
    ]);
    expect(
      report.imports.map((entry) => [
        entry.name,
        entry.binding,
        entry.type,
        entry.version,
      ]),
    ).toEqual([
      [
        "printf",
        "global",
        "function",
        {
          index: 3,
          hidden: false,
          name: "GLIBC_2.34",
          file: "libc.so.6",
          status: "resolved",
        },
      ],
      [
        "memcpy",
        "global",
        "function",
        {
          index: 2,
          hidden: false,
          name: "GLIBC_2.2.5",
          file: "libc.so.6",
          status: "resolved",
        },
      ],
      [
        "_ZSt4cout",
        "global",
        "object",
        {
          index: 4,
          hidden: false,
          name: "GLIBCXX_3.4.29",
          file: "libstdc++.so.6",
          status: "resolved",
        },
      ],
      [
        "abort",
        "global",
        "function",
        {
          index: 1,
          hidden: false,
          name: null,
          file: null,
          status: "unversioned",
        },
      ],
      [
        "_exit",
        "global",
        "function",
        {
          index: 2,
          hidden: true,
          name: "GLIBC_2.2.5",
          file: "libc.so.6",
          status: "resolved",
        },
      ],
    ]);
    expect(report.coverage.examined_versions).toBe(6);
    expect(report.limitations.join(" ")).toContain("dynamic loader");
  },
);

it("keeps duplicate DT_NEEDED names in file order", () => {
  const report = parse(
    elfDependencyFixture({ needed: ["libc.so.6", "libc.so.6", "libm.so.6"] }),
  );
  expect(report.needed.map((entry) => entry.name)).toEqual([
    "libc.so.6",
    "libc.so.6",
    "libm.so.6",
  ]);
});

it("reports an empty complete inventory when PT_DYNAMIC is absent", () => {
  const report = parse(
    elfDependencyFixture({ omitDynamic: true, interpreter: null }),
  );
  expect(report).toMatchObject({
    interpreter: { status: "absent", path: null, location: null },
    dynamic: {
      status: "absent",
      location: null,
      soname: null,
      rpath: null,
      runpath: null,
      flags: null,
      flags_1: null,
    },
    needed: [],
    imports: [],
    coverage: {
      status: "complete",
      examined_needed: 0,
      examined_versions: 0,
      examined_imports: 0,
    },
    issues: [],
  });
  expect(report.limitations[0]).toContain("No PT_DYNAMIC");
});

it("falls back to PT_DYNAMIC and DT_* virtual addresses when section headers are stripped", () => {
  const report = parse(elfDependencyFixture({ stripped: true }));
  expect(report.coverage.status).toBe("complete");
  expect(report.needed.map((entry) => entry.name)).toEqual(defaultNeeded);
  expect(report.dynamic.soname?.name).toBe("libdemo.so.1");
  expect(report.dynamic.runpath?.tokens).toEqual(["$ORIGIN"]);
  expect(report.imports.map((entry) => entry.name)).toEqual([
    "printf",
    "memcpy",
    "_ZSt4cout",
    "abort",
    "_exit",
  ]);
  expect(report.version_requirements.files[0]?.file).toBe("libc.so.6");

  const blocked = parse(
    elfDependencyFixture({ stripped: true, versymZeroFillOffset: 1 }),
  );
  expect(blocked.imports).toEqual(
    report.imports.map((entry) => ({ ...entry, version: null })),
  );
  expect(blocked.coverage.status).toBe("partial");
  expect(blocked.issues).toContainEqual(
    expect.objectContaining({
      code: "table_unavailable",
      message:
        "GNU versym table could not be located from section headers or DT_VERSYM",
    }),
  );
});

it.each([
  { table: "version_requirements", tag: 0x6ffffffen, leading: 48 },
  { table: "version_definitions", tag: 0x6ffffffcn, leading: 28 },
] as const)(
  "keeps only the mapped $table prefix when a later load translates differently",
  ({ table, tag, leading }) => {
    const original = elfDependencyFixture({
      stripped: true,
      verdef: [
        { name: "libdemo.so.1", index: 1, flags: 1 },
        { name: "DEMO_1.0", index: 5 },
      ],
    });
    const headers = elf64ProgramHeaders(original);
    const start = elf64DynamicTags(original, headers.programHeaders).get(tag);
    if (start === undefined)
      throw new Error("Expected the selected dynamic version table");
    const { bytes, alias } = appendElf64ZeroFill(original, headers);
    const boundary = start + BigInt(leading);
    for (const field of [16, 24])
      bytes.writeBigUInt64LE(boundary, alias + field);
    bytes.writeBigUInt64LE(1n, alias + 32);
    bytes.writeBigUInt64LE(boundary, alias + 8);
    const intact = parse(bytes);
    expect(intact.coverage.status).toBe("complete");

    // Readable bytes in the original file no longer establish this virtual address.
    bytes.writeBigUInt64LE(0n, alias + 8);
    const blocked = parse(bytes);
    const expectedTable = intact[table];
    expect(blocked[table]).toMatchObject({
      status: "unreadable",
      location: { offset: Number(start), bytes: leading },
      ...("files" in expectedTable
        ? { files: expectedTable.files.slice(0, 1) }
        : { names: expectedTable.names.slice(0, 1) }),
    });
    expect(blocked.coverage.status).toBe("partial");
    expect(blocked.needed).toEqual(intact.needed);
    expect(blocked.imports).toEqual(
      table === "version_definitions"
        ? intact.imports
        : intact.imports.map((row) =>
            row.name === "_ZSt4cout"
              ? {
                  ...row,
                  version: {
                    index: 4,
                    hidden: false,
                    name: null,
                    file: null,
                    status: "unknown",
                  },
                }
              : row,
          ),
    );
  },
);

it("reads a stripped DT_HASH that crosses two adjacent PT_LOAD mappings", () => {
  const report = parse(
    elfDependencyFixture({ stripped: true, splitLoadAtHash: true }),
  );
  expect(report.coverage.status).toBe("complete");
  expect(report.imports.map((entry) => entry.name)).toEqual([
    "printf",
    "memcpy",
    "_ZSt4cout",
    "abort",
    "_exit",
  ]);
});

it("keeps the symbol section when the dynamic hash count is only file-backed", () => {
  const base = elfDependencyFixture({ splitLoadAtHash: true });
  const { programHeaders } = elf64ProgramHeaders(base);
  const tags = elf64DynamicTags(base, programHeaders);
  const hash = tags.get(4n);
  const dynsym = tags.get(6n);
  const tail = programHeaders.filter(
    (header) => base.readUInt32LE(header) === 1,
  )[1];
  if (hash === undefined || dynsym === undefined || tail === undefined)
    throw new Error("Expected hash and symbol tables in two loads");
  const original = parse(base);
  for (const start of [hash + 12n, dynsym]) {
    const bytes = Buffer.from(base);
    // The header maps, but the body has a gap either before or at its last word.
    const skipped = start - bytes.readBigUInt64LE(tail + 8);
    for (const field of [8, 16, 24])
      bytes.writeBigUInt64LE(start, tail + field);
    const remaining = bytes.readBigUInt64LE(tail + 32) - skipped;
    for (const field of [32, 40])
      bytes.writeBigUInt64LE(remaining, tail + field);
    bytes.writeUInt32LE(2, Number(hash) + 4);
    const report = parse(bytes);
    expect(report.imports, `post-gap load at 0x${start.toString(16)}`).toEqual(
      original.imports,
    );
    expect(report.coverage.status).toBe("complete");
  }
});

it("counts stripped dynsym rows from DT_GNU_HASH when DT_HASH is absent", () => {
  const report = parse(
    elfDependencyFixture({ stripped: true, omitHash: true, gnuHash: true }),
  );
  expect(report.coverage.status).toBe("complete");
  expect(report.imports.map((entry) => entry.name)).toEqual([
    "printf",
    "memcpy",
    "_ZSt4cout",
    "abort",
    "_exit",
  ]);
});

it("reports the symbol count as unavailable when a DT_GNU_HASH bucket precedes its first symbol", () => {
  const report = parse(
    elfDependencyFixture({
      stripped: true,
      omitHash: true,
      gnuHash: true,
      gnuBucketBelowFirstSymbol: true,
    }),
  );
  expect(report.coverage.status).toBe("partial");
  expect(report.imports).toEqual([]);
  expect(
    report.issues.some((issue) => issue.code === "table_unavailable"),
  ).toBe(true);
});

it("reports the symbol count as unavailable when every DT_GNU_HASH bucket is empty", () => {
  const report = parse(
    elfDependencyFixture({
      stripped: true,
      omitHash: true,
      gnuHash: true,
      gnuEmptyBuckets: true,
    }),
  );
  expect(report.coverage.status).toBe("partial");
  expect(report.imports).toEqual([]);
  expect(
    report.issues.some((issue) => issue.code === "table_unavailable"),
  ).toBe(true);
});

it("keeps a complete empty import list when a stripped image has no hash table", () => {
  const report = parse(
    elfDependencyFixture({ stripped: true, omitHash: true }),
  );
  expect(report.coverage.status).toBe("partial");
  expect(report.imports).toEqual([]);
  expect(
    report.issues.some((issue) => issue.code === "table_unavailable"),
  ).toBe(true);
  expect(report.needed.map((entry) => entry.name)).toEqual(defaultNeeded);
});

it("accepts ET_EXEC images as a loadable dynamic-dependency inventory", () => {
  const report = parse(elfDependencyFixture({ type: 2 }));
  expect(report.type).toBe(2);
  expect(report.type_name).toBe("executable");
  expect(report.needed.map((entry) => entry.name)).toEqual(defaultNeeded);
});

it("keeps an unknown versym index explicit and marks coverage partial", () => {
  const report = parse(
    elfDependencyFixture({
      imports: [{ name: "mystery", version: 99 }],
    }),
  );
  expect(report.coverage.status).toBe("partial");
  expect(report.imports).toEqual([
    expect.objectContaining({
      name: "mystery",
      version: {
        index: 99,
        hidden: false,
        name: null,
        file: null,
        status: "unknown",
      },
    }),
  ]);
  expect(
    report.issues.some((issue) => issue.code === "version_unresolved"),
  ).toBe(true);
});

it("reports RPATH entries and ${} search tokens as written", () => {
  const report = parse(
    elfDependencyFixture({
      rpath: "$ORIGIN:$LIB:${PLATFORM}/lib:",
      runpath: null,
    }),
  );
  expect(report.dynamic.rpath).toEqual({
    raw: "$ORIGIN:$LIB:${PLATFORM}/lib:",
    entries: ["$ORIGIN", "$LIB", "${PLATFORM}/lib", ""],
    tokens: ["$ORIGIN", "$LIB", "$PLATFORM"],
  });
  expect(report.dynamic.runpath).toBeNull();
});

it("rejects relocatable objects toward inspect_kernel_module", () => {
  expect(() => parse(elfDependencyFixture({ type: 1 }))).toThrow(
    BinaryFormatFailure,
  );
  try {
    parse(elfDependencyFixture({ type: 1 }));
  } catch (cause) {
    expect(cause).toBeInstanceOf(BinaryFormatFailure);
    if (cause instanceof BinaryFormatFailure) {
      expect(cause.kind).toBe("malformed");
      expect(cause.message).toContain("inspect_kernel_module");
    }
  }
});

it("rejects core dumps toward inspect_recorded_crash", () => {
  try {
    parse(elfDependencyFixture({ type: 4 }));
    throw new Error("Expected core-dump rejection");
  } catch (cause) {
    expect(cause).toBeInstanceOf(BinaryFormatFailure);
    if (cause instanceof BinaryFormatFailure) {
      expect(cause.message).toContain("inspect_recorded_crash");
    }
  }
});

it("rejects a non-ELF buffer before decoding dynamic tags", () => {
  try {
    parse(Buffer.from("not an elf"));
    throw new Error("Expected ELF framing rejection");
  } catch (cause) {
    expect(cause).toBeInstanceOf(BinaryFormatFailure);
    if (cause instanceof BinaryFormatFailure)
      expect(cause.message).toContain("not an ELF image");
  }
});

it("keeps the readable prefix when a GNU version chain ends before its count", () => {
  const healthy = parse(elfDependencyFixture());
  const verneed = parse(
    elfDependencyFixture({ earlyVersionLinkEnd: "verneed" }),
  );
  expect(verneed.coverage.status).toBe("partial");
  expect(verneed.needed).toEqual(healthy.needed);
  expect(verneed.version_requirements.status).toBe("unreadable");
  expect(verneed.version_requirements.files.map((file) => file.file)).toEqual([
    "libc.so.6",
  ]);
  expect(verneed.issues).toContainEqual(
    versionTableIssue(healthy.version_requirements),
  );

  // The file entry whose auxiliary chain ended early stays out of the join.
  const vernaux = parse(
    elfDependencyFixture({ earlyVersionLinkEnd: "vernaux" }),
  );
  expect(vernaux.coverage.status).toBe("partial");
  expect(vernaux.needed).toEqual(healthy.needed);
  expect(vernaux.version_requirements.status).toBe("unreadable");
  expect(vernaux.version_requirements.files).toEqual([]);
  expect(vernaux.issues).toContainEqual(
    versionTableIssue(healthy.version_requirements),
  );
});

it("reports a dynamic string past the scan limit as a limit, not unterminated", () => {
  const soname = `lib${"s".repeat(70000)}.so`;
  const report = parse(elfDependencyFixture({ soname }));
  expect(report.dynamic.soname?.name).toBeNull();
  expect(report.coverage.status).toBe("partial");
  const issue = report.issues.find((entry) => entry.code === "name_unreadable");
  expect(issue?.message).toMatch(/65536-byte string scan limit/u);
  expect(issue?.message).not.toMatch(/unterminated/u);
});

it("reports GNU version tables with an unsupported revision as unreadable", () => {
  const verneed = parse(
    elfDependencyFixture({ unsupportedVersionRevision: "verneed" }),
  );
  expect(verneed.coverage.status).toBe("partial");
  expect(verneed.version_requirements).toMatchObject({
    status: "unreadable",
    files: [],
  });
  expect(
    verneed.imports.some((entry) => entry.version?.status === "resolved"),
  ).toBe(false);
  expect(verneed.issues).toContainEqual(
    expect.objectContaining({ code: "version_unresolved" }),
  );

  const verdef = parse(
    elfDependencyFixture({ unsupportedVersionRevision: "verdef" }),
  );
  expect(verdef.coverage.status).toBe("partial");
  expect(verdef.version_definitions).toMatchObject({
    status: "unreadable",
    names: [],
  });
});

it.each([
  {
    label: "declares no auxiliary records",
    auxiliary: { count: 0, next: 0 },
  },
  {
    label: "declares more auxiliary records than it holds",
    auxiliary: { count: 2, next: 8 },
  },
  {
    label: "ends its auxiliary chain with a zero link before its count",
    auxiliary: { count: 2, next: 0 },
  },
  {
    label: "links past its declared auxiliary count",
    auxiliary: { count: 1, next: 8 },
  },
])("reports a GNU version definition that $label", ({ auxiliary }) => {
  const healthy = parse(elfDependencyFixture());
  const report = parse(elfDependencyFixture({ verdefAuxiliary: auxiliary }));
  expect(report.coverage.status).toBe("partial");
  expect(report.version_definitions).toMatchObject({
    status: "unreadable",
    location: healthy.version_definitions.location,
    names: [],
  });
  const unresolved = report.issues.filter(
    (entry) => entry.code === "version_unresolved",
  );
  expect(unresolved).toHaveLength(1);
  expect(unresolved[0]?.location).toMatch(/^0x[0-9a-f]+$/u);
  // The malformed definition table leaves the rest of the inventory readable.
  expect(report.needed).toEqual(healthy.needed);
  expect(report.version_requirements).toEqual(healthy.version_requirements);
});

it("reports a GNU version chain that continues past its declared count", () => {
  const healthy = parse(elfDependencyFixture());
  const verneed = parse(
    elfDependencyFixture({ danglingVersionLink: "verneed" }),
  );
  expect(verneed.coverage.status).toBe("partial");
  expect(verneed.version_requirements.status).toBe("unreadable");
  expect(verneed.version_requirements.files.map((file) => file.file)).toEqual([
    "libc.so.6",
    "libstdc++.so.6",
  ]);
  expect(verneed.issues).toContainEqual(
    versionTableIssue(healthy.version_requirements),
  );

  // The file entry whose auxiliary chain is unfinished stays out of the join.
  const vernaux = parse(
    elfDependencyFixture({ danglingVersionLink: "vernaux" }),
  );
  expect(vernaux.coverage.status).toBe("partial");
  expect(vernaux.version_requirements.status).toBe("unreadable");
  expect(vernaux.version_requirements.files.map((file) => file.file)).toEqual([
    "libc.so.6",
  ]);
  expect(vernaux.issues).toContainEqual(
    versionTableIssue(healthy.version_requirements),
  );

  const verdef = parse(elfDependencyFixture({ danglingVersionLink: "verdef" }));
  expect(verdef.coverage.status).toBe("partial");
  expect(verdef.version_definitions.status).toBe("unreadable");
  expect(verdef.version_definitions.names.map((entry) => entry.name)).toEqual([
    "libdemo.so.1",
  ]);
  expect(verdef.issues).toContainEqual(
    versionTableIssue(healthy.version_definitions),
  );
});

it.each([
  [".gnu.version_r", "GNU version requirements"],
  [".gnu.version_d", "GNU version definitions"],
] as const)(
  "clamps a %s section that declares bytes past the file end",
  (oversizedSection, label) => {
    const bytes = elfDependencyFixture({ oversizedSection });
    const intact = parse(elfDependencyFixture());
    const report = parse(bytes);
    expect(report.coverage.status).toBe("partial");
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "malformed_entry",
        message: expect.stringContaining(label),
      }),
    );
    expect(report.needed).toEqual(intact.needed);
    expect(report.imports).toEqual(intact.imports);
    expect(report.version_requirements.files).toEqual(
      intact.version_requirements.files,
    );
    expect(report.version_definitions.names).toEqual(
      intact.version_definitions.names,
    );
    for (const { location } of [
      report.version_requirements,
      report.version_definitions,
    ]) {
      if (location === null) throw new Error("Expected a version table range");
      expect(location.offset + location.bytes).toBeLessThanOrEqual(
        bytes.length,
      );
    }
  },
);

it.each([".dynsym", ".gnu.version"])(
  "keeps imports when %s declares bytes past the file end",
  (oversizedSection) => {
    const report = parse(elfDependencyFixture({ oversizedSection }));
    expect(report.coverage.status).toBe("partial");
    expect(report.imports).toEqual(parse(elfDependencyFixture()).imports);
  },
);

it("keeps readable facts when the .hash fallback section is past the file end", () => {
  const intact = parse(elfDependencyFixture());
  const report = parse(
    elfDependencyFixture({
      oversizedSection: ".dynsym",
      displacedSection: ".hash",
      omitHashTag: true,
    }),
  );
  expect(report.coverage.status).toBe("partial");
  expect(report.needed).toEqual(intact.needed);
  expect(report.version_requirements.files).toEqual(
    intact.version_requirements.files,
  );
  expect(report.issues).toContainEqual(
    expect.objectContaining({
      code: "malformed_entry",
      message: expect.stringContaining(".hash section header"),
    }),
  );
  expect(report.issues).toContainEqual(
    expect.objectContaining({
      code: "table_unavailable",
      message: expect.stringContaining("Dynamic symbol count"),
    }),
  );
});

it("takes the symbol count from GNU hash when .hash is past the file end", () => {
  const report = parse(
    elfDependencyFixture({
      oversizedSection: ".dynsym",
      displacedSection: ".hash",
      omitHashTag: true,
      gnuHash: true,
    }),
  );
  expect(report.coverage.status).toBe("partial");
  expect(report.imports).toEqual(
    parse(elfDependencyFixture({ gnuHash: true })).imports,
  );
});

it("falls back to DT_GNU_HASH when SHT_GNU_HASH is truncated", () => {
  const intact = parse(
    elfDependencyFixture({
      omitHash: true,
      gnuHash: true,
      gnuHashSection: true,
    }),
  );
  const report = parse(
    elfDependencyFixture({
      omitHash: true,
      gnuHash: true,
      gnuHashSection: true,
      oversizedSection: ".dynsym",
      sectionSizes: { ".gnu.hash": 16 },
    }),
  );
  expect(report.coverage.status).toBe("partial");
  expect(report.imports).toEqual(intact.imports);
  expect(
    report.issues.some((issue) => issue.code === "table_unavailable"),
  ).toBe(false);
});

it("reports .gnu.hash past EOF and falls back to DT_GNU_HASH", () => {
  const intact = parse(
    elfDependencyFixture({
      omitHash: true,
      gnuHash: true,
      gnuHashSection: true,
    }),
  );
  const withDynamic = parse(
    elfDependencyFixture({
      omitHash: true,
      gnuHash: true,
      gnuHashSection: true,
      oversizedSection: ".dynsym",
      sectionSizes: { ".gnu.hash": 100_000 },
    }),
  );
  expect(withDynamic.coverage.status).toBe("partial");
  expect(withDynamic.imports).toEqual(intact.imports);
  expect(withDynamic.issues).toContainEqual(
    expect.objectContaining({
      code: "malformed_entry",
      message:
        ".gnu.hash section header declares bytes past the end of the file",
    }),
  );

  const withoutDynamic = parse(
    elfDependencyFixture({
      omitHash: true,
      gnuHash: true,
      gnuHashSection: true,
      oversizedSection: ".dynsym",
      displacedSection: ".gnu.hash",
      omitGnuHashTag: true,
    }),
  );
  expect(withoutDynamic.coverage.status).toBe("partial");
  expect(withoutDynamic.imports).toEqual([]);
  expect(withoutDynamic.issues).toContainEqual(
    expect.objectContaining({
      code: "malformed_entry",
      message:
        ".gnu.hash section header declares bytes past the end of the file",
    }),
  );
  expect(withoutDynamic.issues).toContainEqual(
    expect.objectContaining({
      code: "table_unavailable",
      message: expect.stringContaining("Dynamic symbol count"),
    }),
  );
});

it("reads symbol count from an in-file SHT_GNU_HASH section when DT_GNU_HASH is absent", () => {
  const intact = parse(
    elfDependencyFixture({
      omitHash: true,
      gnuHash: true,
      gnuHashSection: true,
    }),
  );
  const report = parse(
    elfDependencyFixture({
      omitHash: true,
      gnuHash: true,
      gnuHashSection: true,
      omitGnuHashTag: true,
      oversizedSection: ".dynsym",
    }),
  );
  expect(report.coverage.status).toBe("partial");
  expect(report.imports).toEqual(intact.imports);
  expect(
    report.issues.some((issue) => issue.message.includes(".gnu.hash")),
  ).toBe(false);
});

it.each([32, 64] as const)(
  "keeps ELF%i imports inside aligned and unaligned short dynamic symbol sections",
  (bits) => {
    const prefix = parse(elfDependencyFixture({ bits })).imports.slice(0, 2);
    for (const tail of [0, 1]) {
      const sectionBytes = 3 * (bits === 64 ? 24 : 16) + tail;
      const report = parse(
        elfDependencyFixture({
          bits,
          sectionSizes: { ".dynsym": sectionBytes },
        }),
      );
      expect(report.coverage.status, `trailing bytes: ${tail}`).toBe("partial");
      expect(report.imports).toEqual(prefix);
      expect(report.issues).toContainEqual(
        expect.objectContaining({
          code: "malformed_entry",
          message: expect.stringContaining("dynamic symbol count"),
        }),
      );
    }
  },
);

it("keeps DT_HASH authoritative over an aligned extra symbol row", () => {
  const inspect = (symbols: number) => {
    const bytes = elfDependencyFixture({
      sectionSizes: { ".dynsym": symbols * 24 },
    });
    const { programHeaders } = elf64ProgramHeaders(bytes);
    const strings = elf64DynamicTags(bytes, programHeaders).get(5n);
    if (strings === undefined) throw new Error("Expected DT_STRTAB");
    // The bytes after .dynsym would look like an undefined symbol if trusted.
    bytes.writeUInt16LE(0, Number(strings) + 6);
    return parse(bytes);
  };
  const report = inspect(7);
  expect(report.imports).toEqual(inspect(6).imports);
  expect(report.coverage.status).toBe("partial");
  expect(report.issues).toContainEqual(
    expect.objectContaining({
      code: "malformed_entry",
      message: expect.stringContaining("past the DT_HASH dynamic symbol count"),
    }),
  );
});

it.each([32, 64] as const)(
  "strides ELF%i symbols by the class width when .dynsym sh_entsize disagrees",
  (bits) => {
    // No DT_SYMENT, and a section entry size twice the class width: reading
    // with the declared width would skip every other symbol and pair the rest
    // with the wrong version slots.
    const bytes = elfDependencyFixture({
      bits,
      omitSymentTag: true,
      sectionEntrySizes: { ".dynsym": bits === 64 ? 48 : 32 },
    });
    const report = parse(bytes);
    expect(report.coverage.status).toBe("partial");
    expect(report.imports).toEqual(
      parse(elfDependencyFixture({ bits })).imports,
    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "malformed_entry",
        location: `0x${sectionOffset(bytes, bits, SHT_DYNSYM).toString(16)}`,
      }),
    );
  },
);

const SHT_DYNSYM = 0xb;
const SHT_GNU_VERSYM = 0x6fffffff;

/** The file offset of the little-endian fixture's first section of a type. */
const sectionOffset = (bytes: Buffer, bits: 32 | 64, type: number): number => {
  const wide = bits === 64;
  const shoff = wide
    ? Number(bytes.readBigUInt64LE(0x28))
    : bytes.readUInt32LE(0x20);
  const width = bytes.readUInt16LE(wide ? 0x3a : 0x2e);
  const count = bytes.readUInt16LE(wide ? 0x3c : 0x30);
  for (let index = 0; index < count; index += 1) {
    const header = shoff + index * width;
    if (bytes.readUInt32LE(header + 4) !== type) continue;
    return wide
      ? Number(bytes.readBigUInt64LE(header + 24))
      : bytes.readUInt32LE(header + 16);
  }
  throw new Error(`fixture has no section of type 0x${type.toString(16)}`);
};

it.each([32, 64] as const)(
  "keeps ELF%i versions for the whole slots of a short .gnu.version table",
  (bits) => {
    // Six bytes hold the null slot and the slots of the first two imports.
    const bytes = elfDependencyFixture({
      bits,
      sectionSizes: { ".gnu.version": 6 },
    });
    const report = parse(bytes);
    const complete = parse(elfDependencyFixture({ bits })).imports;
    expect(report.coverage.status).toBe("partial");
    expect(report.imports.slice(0, 2)).toEqual(complete.slice(0, 2));
    expect(report.imports[0]?.version).not.toBeNull();
    expect(report.imports[1]?.version).not.toBeNull();
    expect(report.imports.slice(2).map((row) => row.version)).toEqual(
      complete.slice(2).map(() => null),
    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "table_unavailable",
        location: `0x${sectionOffset(bytes, bits, SHT_GNU_VERSYM).toString(16)}`,
      }),
    );
  },
);

it("keeps readable names and marks truncated dynstr coverage partial", () => {
  const report = parse(elfDependencyFixture({ truncateDynstr: true }));
  expect(report.coverage.status).toBe("partial");
  expect(report.issues.some((issue) => issue.code === "name_unreadable")).toBe(
    true,
  );
  expect(report.needed.map((entry) => entry.name)).toEqual(defaultNeeded);
});

it("keeps readable results when an ELF64 name offset exceeds 32 bits", () => {
  const report = parse(
    elfDependencyFixture({ bits: 64, wideNameOffset: 0x100000000 }),
  );
  expect(report.needed[0]).toMatchObject({
    name: null,
    name_offset: 0x100000000,
  });
  expect(report.dynamic?.soname).toMatchObject({
    name: null,
    name_offset: 0x100000000,
  });
  expect(report.needed.slice(1).map((entry) => entry.name)).toEqual(
    defaultNeeded.slice(1),
  );
});

it("distinguishes SONAME termination at the scan boundary from a bare table end", () => {
  const base = { runpath: null, imports: [], verneed: [], verdef: [] };
  const terminated = parse(
    elfDependencyFixture({ ...base, soname: "s".repeat(65535) }),
  );
  expect(terminated.dynamic.soname?.name).toHaveLength(65535);
  expect(terminated.coverage.status).toBe("complete");
  const unterminated = parse(
    elfDependencyFixture({
      ...base,
      soname: "s".repeat(65536),
      truncateDynstr: true,
    }),
  );
  expect(unterminated.dynamic.soname?.name).toBeNull();
  expect(unterminated.coverage.status).toBe("partial");
  expect(unterminated.issues).toContainEqual({
    location: "DT_SONAME",
    code: "name_unreadable",
    message: "DT_SONAME string is unterminated in the dynamic string table",
  });
});

it("rejects duplicate unique dynamic tags", () => {
  expect(() => parse(elfDependencyFixture({ duplicateSoname: true }))).toThrow(
    /Duplicate dynamic tag/u,
  );
});

it.each([
  ["DT_NEEDED entries", { max_needed: 2 }, "max_needed"],
  ["GNU version records", { max_versions: 2 }, "max_versions"],
  ["Undefined dynamic symbols", { max_imports: 2 }, "max_imports"],
] as const)(
  "names the caller budget when %s fail",
  (_entries, budget, parameter) => {
    expect(() => parse(elfDependencyFixture(), budget)).toThrow(
      expect.objectContaining({
        failure: expect.objectContaining({
          kind: "limit",
          format: "elf-dependencies",
          limit: { name: parameter, maximum: 2, required: 3 },
        }),
      }),
    );
  },
);

it("keeps ELF64 flag bits above the low 32", () => {
  const report = parse(
    elfDependencyFixture({ flags: 0x100000008, flags1: 0x200000001 }),
  );
  expect(report.dynamic).toMatchObject({
    flags: { raw: 0x100000008, names: ["BIND_NOW"], unrecognized: 0x100000000 },
    flags_1: { raw: 0x200000001, names: ["NOW"], unrecognized: 0x200000000 },
  });
});

it("refuses a flag word past the safe integer range rather than cutting it", () => {
  expect(() => parse(elfDependencyFixture({ flags: 2 ** 60 }))).toThrow(
    /not representable/u,
  );
});

const elf64ProgramHeader = (bytes: Buffer, type: number): number => {
  const phoff = Number(bytes.readBigUInt64LE(32));
  const phentsize = bytes.readUInt16LE(54);
  for (let index = 0; index < bytes.readUInt16LE(56); index += 1) {
    const base = phoff + index * phentsize;
    if (bytes.readUInt32LE(base) === type) return base;
  }
  throw new Error(`Fixture has no program header of type ${type}`);
};

it.each([0x1_0000_0000n, 0x1_0000_0001n])(
  "does not match ELF64 tag %s against a known 32-bit tag",
  (tag) => {
    const bytes = elfDependencyFixture({ bits: 64, little: true });
    const program = elf64ProgramHeader(bytes, 2);
    const dynamic = Number(bytes.readBigUInt64LE(program + 8));
    expect(bytes.readBigUInt64LE(dynamic)).toBe(1n);
    bytes.writeBigUInt64LE(tag, dynamic);
    expect(parse(bytes).needed.map((entry) => entry.name)).toEqual(
      defaultNeeded.slice(1),
    );
  },
);

it("keeps the inventory when PT_INTERP points outside the file", () => {
  const bytes = elfDependencyFixture({ bits: 64, little: true });
  const program = elf64ProgramHeader(bytes, 3);
  bytes.writeBigUInt64LE(BigInt(bytes.length + 16), program + 8);
  const report = parse(bytes);
  expect(report.interpreter).toEqual({
    status: "unreadable",
    path: null,
    location: null,
  });
  expect(report.coverage.status).toBe("partial");
  expect(report.issues).toContainEqual(
    expect.objectContaining({
      code: "table_unavailable",
      location: `0x${(bytes.length + 16).toString(16)}`,
    }),
  );
  expect(report.needed.map((entry) => entry.name)).toEqual(defaultNeeded);
});

/** Point PT_INTERP at appended 0x01 bytes, optionally ending in a NUL. */
const longInterpreter = (
  length: number,
  terminated: boolean,
): { readonly bytes: Buffer; readonly offset: number } => {
  const template = elfDependencyFixture({ bits: 64, little: true });
  const program = elf64ProgramHeader(template, 3);
  const offset = template.length;
  const bytes = Buffer.concat([template, Buffer.alloc(length, 1)]);
  if (terminated) bytes[bytes.length - 1] = 0;
  bytes.writeBigUInt64LE(BigInt(offset), program + 8);
  bytes.writeBigUInt64LE(BigInt(length), program + 32);
  return { bytes, offset };
};

it.each([
  ["no terminator", false],
  ["a terminator past the scan limit", true],
] as const)(
  "keeps the inventory when a PT_INTERP path has %s",
  (_label, terminated) => {
    const { bytes, offset } = longInterpreter(65537, terminated);
    const report = parse(bytes);
    expect(report.interpreter).toEqual({
      status: "unreadable",
      path: null,
      location: { offset, bytes: 65537 },
    });
    expect(report.coverage.status).toBe("partial");
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "name_unreadable",
        location: `0x${offset.toString(16)}`,
      }),
    );
    expect(report.needed.map((entry) => entry.name)).toEqual(defaultNeeded);
  },
);

it("reports a PT_INTERP segment that fits the scan limit as unterminated", () => {
  const { bytes, offset } = longInterpreter(65536, false);
  const report = parse(bytes);
  expect(report.interpreter).toEqual({
    status: "unreadable",
    path: null,
    location: { offset, bytes: 65536 },
  });
  expect(report.coverage.status).toBe("partial");
  expect(report.issues).toContainEqual(
    expect.objectContaining({
      code: "name_unreadable",
      location: `0x${offset.toString(16)}`,
    }),
  );
});

it("reports a PT_INTERP path that ends at the last scanned byte", () => {
  const report = parse(longInterpreter(65536, true).bytes);
  expect(report.interpreter.status).toBe("present");
  expect(report.interpreter.path).toHaveLength(65535);
});

it("marks an empty PT_INTERP path unreadable with partial coverage", () => {
  const report = parse(elfDependencyFixture({ interpreter: "" }));
  expect(report.interpreter.status).toBe("unreadable");
  expect(report.coverage.status).toBe("partial");
  expect(report.issues).toContainEqual(
    expect.objectContaining({ code: "name_unreadable" }),
  );
});

it("joins import versions only with one complete owning library and name", () => {
  const report = parse(
    elfDependencyFixture({
      verneed: [
        {
          file: "liba.so.1",
          versions: [
            { name: "A_1.0", index: 2 },
            { name: "", index: 4 },
            { name: "A_5.0", index: 5 },
          ],
        },
        {
          file: "",
          versions: [
            { name: "B_3.0", index: 3 },
            { name: "", index: 6 },
          ],
        },
        {
          file: "libc.so.1",
          versions: [
            { name: "C_5.0", index: 5 },
            { name: "C_6.0", index: 6 },
          ],
        },
      ],
      imports: [2, 3, 4, 5, 6].map((version) => ({
        name: `sym_${version}`,
        version,
      })),
    }),
  );
  expect(report.coverage.status).toBe("partial");
  expect(report.imports.map(({ version }) => version)).toEqual(
    [
      [2, "A_1.0", "liba.so.1", "resolved"],
      [3, "B_3.0", null, "unknown"],
      [4, null, "liba.so.1", "unknown"],
      [5, null, null, "unknown"],
      [6, null, null, "unknown"],
    ].map(([index, name, file, status]) => ({
      index,
      name,
      file,
      status,
      hidden: false,
    })),
  );
  expect(report.version_requirements.files[1]).toMatchObject({
    file: null,
    versions: [
      { index: 3, name: "B_3.0" },
      { index: 6, name: null },
    ],
  });
  expect(
    report.issues.filter(({ code }) => code === "version_unresolved"),
  ).toEqual(
    [5, 6].map((index) =>
      expect.objectContaining({
        message: expect.stringContaining(
          `assign version index ${index} more than once`,
        ),
      }),
    ),
  );
});

it("charges every retained reference to one repeated dynamic string", () => {
  const name = `sym_${"x".repeat(60000)}`;
  const bytes = elfDependencyFixture({
    imports: Array.from({ length: 64 }, () => ({ name })),
    verneed: [],
    verdef: [],
  });
  let failure: unknown;
  try {
    parse(bytes);
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(ParseFailureError);
  expect(failure).toMatchObject({
    failure: {
      kind: "limit",
      limit: { name: "retained_text_bytes", maximum: bytes.length },
    },
  });
  expect((failure as Error).message).toContain(
    `${String(bytes.length)}-byte budget fixed by the admitted image length`,
  );
});

it("keeps DT_STRTAB names when the linked .dynstr section names other bytes", () => {
  const bytes = elfDependencyFixture({});
  const shoff = Number(bytes.readBigUInt64LE(0x28));
  const width = bytes.readUInt16LE(0x3a);
  const count = bytes.readUInt16LE(0x3c);
  const names = bytes.readUInt16LE(0x3e);
  const header = (index: number) => shoff + index * width;
  const dynsym = Array.from({ length: count }, (_, index) => index).find(
    (index) => bytes.readUInt32LE(header(index) + 4) === 11,
  );
  if (dynsym === undefined) throw new Error("fixture has no .dynsym");
  const dynstr = bytes.readUInt32LE(header(dynsym) + 40);
  // Point the linked string section at .shstrtab while DT_STRTAB is unchanged.
  bytes.writeBigUInt64LE(
    bytes.readBigUInt64LE(header(names) + 24),
    header(dynstr) + 24,
  );
  const report = parse(bytes);
  expect(report.needed.map((entry) => entry.name)).toEqual(defaultNeeded);
  expect(report.dynamic.soname?.name).toBe("libdemo.so.1");
  expect(report.coverage.status).toBe("partial");
  expect(report.issues).toContainEqual(
    expect.objectContaining({
      code: "malformed_entry",
      message: expect.stringContaining(".dynstr section header disagrees"),
    }),
  );
});

/** Moves every PT_LOAD and address-valued DT_* tag of an ELF64 LE image up by base. */
const relocateElf64 = (bytes: Buffer, base: bigint): Buffer => {
  const moved = Buffer.from(bytes);
  const addressTags = new Set([
    4n,
    5n,
    6n,
    0x6ffffef5n,
    0x6ffffff0n,
    0x6ffffffcn,
    0x6ffffffen,
  ]);
  const phoff = Number(moved.readBigUInt64LE(32));
  const phent = moved.readUInt16LE(54);
  const phnum = moved.readUInt16LE(56);
  for (let index = 0; index < phnum; index += 1) {
    const at = phoff + index * phent;
    const type = moved.readUInt32LE(at);
    if (type === 1)
      for (const field of [16, 24])
        moved.writeBigUInt64LE(
          moved.readBigUInt64LE(at + field) + base,
          at + field,
        );
    if (type !== 2) continue;
    const start = Number(moved.readBigUInt64LE(at + 8));
    const end = start + Number(moved.readBigUInt64LE(at + 32));
    for (let entry = start; entry + 16 <= end; entry += 16)
      if (addressTags.has(moved.readBigUInt64LE(entry)))
        moved.writeBigUInt64LE(
          moved.readBigUInt64LE(entry + 8) + base,
          entry + 8,
        );
  }
  return moved;
};

it("maps ELF64 table addresses above Number.MAX_SAFE_INTEGER through PT_LOAD", () => {
  const image = elfDependencyFixture({
    bits: 64,
    little: true,
    stripped: true,
  });
  const high = relocateElf64(image, 0xffffffff00000000n);
  const report = parse(high);
  expect(report).toEqual(parse(image));
  expect(report.needed.map((entry) => entry.name)).toEqual(defaultNeeded);
  expect(report.imports.length).toBeGreaterThan(0);
});

it("uses the dynamic declaration when two section headers share a dynamic type", () => {
  const bytes = Buffer.from(elfDependencyFixture({ bits: 64, little: true }));
  const shoff = Number(bytes.readBigUInt64LE(0x28));
  const shentsize = bytes.readUInt16LE(0x3a);
  const shnum = bytes.readUInt16LE(0x3c);
  // Retype the dynamic string table's header (SHT_STRTAB) as a second SHT_DYNSYM.
  const types = Array.from({ length: shnum }, (_, index) =>
    bytes.readUInt32LE(shoff + index * shentsize + 4),
  );
  const dynsymCount = types.filter((type) => type === 11).length;
  expect(dynsymCount).toBe(1);
  const strtab = types.indexOf(3);
  bytes.writeUInt32LE(11, shoff + strtab * shentsize + 4);
  const report = parse(bytes);
  expect(report.issues).toContainEqual(
    expect.objectContaining({
      code: "malformed_entry",
      message:
        "More than one .dynsym section header; using the dynamic declaration",
    }),
  );
  expect(report.imports.length).toBeGreaterThan(0);
});

it("surfaces GNU hash checkpoints to the scheduling owner", () => {
  const bytes = elfDependencyFixture({
    stripped: true,
    omitHash: true,
    gnuHash: true,
  });
  const steps = readElfDependenciesSteps(
    bytes,
    {
      path: artifactPath,
      sha256: "ab".repeat(32),
      bytes: bytes.length,
    },
    inspectElfDependenciesInputSchema.parse({ path: artifactPath }),
  );
  expect(steps.next()).toEqual({ done: false, value: undefined });
  let next = steps.next();
  while (!next.done) next = steps.next();
  expect(next.value.imports).toHaveLength(5);
});

it("reports the fixed GNU hash allowance before traversing an over-limit table", () => {
  const bytes = elfDependencyFixture({
    omitHash: true,
    gnuHash: true,
    sectionSizes: { ".dynsym": 1 },
  });
  // The fixture's PT_LOAD uses identity-mapped virtual addresses.
  const dynamic = sectionOffset(bytes, 64, 6);
  let hash: number | undefined;
  for (let offset = dynamic; offset + 16 <= bytes.length; offset += 16) {
    const tag = bytes.readBigUInt64LE(offset);
    if (tag === 0x6ffffef5n) {
      hash = Number(bytes.readBigUInt64LE(offset + 8));
      break;
    }
    if (tag === 0n) break;
  }
  if (hash === undefined)
    throw new Error("Fixture has no GNU hash declaration");
  bytes.writeUInt32LE(MAX_INSPECT_ELF_DEPENDENCY_IMPORTS + 1, hash + 4);
  expect(() => parse(bytes)).toThrowError(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "limit",
        limit: {
          name: "gnu_hash_entries",
          maximum: MAX_INSPECT_ELF_DEPENDENCY_IMPORTS,
          required: MAX_INSPECT_ELF_DEPENDENCY_IMPORTS + 1,
        },
      }),
    }),
  );
});

it.each([
  [2, 32],
  [18, 32],
  [43, 64],
] as const)(
  "does not count SPARC register declarations as imports on machine %s",
  (machine, bits) => {
    // JNA's sunos-sparcv9 libjnidispatch.so declares %g2 and %g3 this way:
    // undefined STT_SPARC_REGISTER (type 13) entries with empty names.
    const report = parse(
      elfDependencyFixture({
        bits,
        little: false,
        machine,
        imports: [
          { name: "printf", version: 1 },
          { name: "", type: 13, version: 0 },
        ],
      }),
    );
    expect(report.imports.map(({ name }) => name)).toEqual(["printf"]);
    expect(report.coverage).toMatchObject({
      status: "complete",
      examined_imports: 1,
    });
    expect(report.issues).toEqual([]);
  },
);

it("keeps processor-specific symbol type 13 as an import outside SPARC", () => {
  const report = parse(
    elfDependencyFixture({
      bits: 64,
      little: true,
      imports: [
        { name: "printf", version: 1 },
        { name: "", type: 13, version: 0 },
      ],
    }),
  );
  expect(report.imports.map(({ name, type }) => [name, type])).toEqual([
    ["printf", "function"],
    [null, "other"],
  ]);
  expect(report.coverage.status).toBe("partial");
});
