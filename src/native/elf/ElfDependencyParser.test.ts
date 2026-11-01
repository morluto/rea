import { expect, it } from "vitest";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  inspectElfDependenciesInputSchema,
  elfDependenciesSchema,
} from "../../domain/native/elfDependencies.js";
import { BinaryFormatFailure } from "../metadata/BinaryContainer.js";
import { elfDependencyFixture, elfHash } from "./ElfDependencies.fixture.js";
import { parseElfDependencies } from "./ElfDependencyParser.js";

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

it("fails cyclic GNU version requirement chains without a complete inventory", () => {
  expect(() => parse(elfDependencyFixture({ cyclicVerneed: true }))).toThrow(
    /cyclic/u,
  );
  expect(() => parse(elfDependencyFixture({ cyclicVernaux: true }))).toThrow(
    /cyclic/u,
  );
});

it("reports a GNU version chain that continues past its declared count", () => {
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
    expect.objectContaining({
      code: "version_unresolved",
      message: expect.stringContaining(
        "GNU version requirement chain continues past its declared count",
      ),
    }),
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
    expect.objectContaining({
      code: "version_unresolved",
      message: expect.stringContaining(
        "GNU version requirement auxiliary chain continues past its declared count",
      ),
    }),
  );

  const verdef = parse(elfDependencyFixture({ danglingVersionLink: "verdef" }));
  expect(verdef.coverage.status).toBe("partial");
  expect(verdef.version_definitions.status).toBe("unreadable");
  expect(verdef.version_definitions.names.map((entry) => entry.name)).toEqual([
    "libdemo.so.1",
  ]);
  expect(verdef.issues).toContainEqual(
    expect.objectContaining({
      code: "version_unresolved",
      message: expect.stringContaining(
        "GNU version definition chain continues past its declared count",
      ),
    }),
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

it("rejects duplicate unique dynamic tags", () => {
  expect(() => parse(elfDependencyFixture({ duplicateSoname: true }))).toThrow(
    /Duplicate dynamic tag/u,
  );
});

it("fails when DT_NEEDED entries exceed the caller-selected budget", () => {
  try {
    parse(elfDependencyFixture(), { max_needed: 2 });
    throw new Error("Expected DT_NEEDED budget failure");
  } catch (cause) {
    expect(cause).toBeInstanceOf(ArtifactReaderFailure);
    if (cause instanceof ArtifactReaderFailure) {
      expect(cause.reason).toBe("limit");
      expect(cause.boundary).toBe("capacity");
      expect(cause.message).toContain("DT_NEEDED");
    }
  }
});

it("fails when GNU version records exceed the caller-selected budget", () => {
  try {
    parse(elfDependencyFixture(), { max_versions: 2 });
    throw new Error("Expected version budget failure");
  } catch (cause) {
    expect(cause).toBeInstanceOf(ArtifactReaderFailure);
    if (cause instanceof ArtifactReaderFailure)
      expect(cause.message).toContain("GNU version records");
  }
});

it("fails when undefined symbols exceed the caller-selected import budget", () => {
  try {
    parse(elfDependencyFixture(), { max_imports: 2 });
    throw new Error("Expected import budget failure");
  } catch (cause) {
    expect(cause).toBeInstanceOf(ArtifactReaderFailure);
    if (cause instanceof ArtifactReaderFailure)
      expect(cause.message).toContain("Undefined dynamic symbols");
  }
});

it.each([
  ["DT_NEEDED entries", { max_needed: 2 }, "max_needed", 65536],
  ["GNU version records", { max_versions: 2 }, "max_versions", 65536],
  ["Undefined dynamic symbols", { max_imports: 2 }, "max_imports", 262144],
] as const)(
  "names the caller budget when %s fail",
  (entries, budget, parameter, ceiling) => {
    expect(() => parse(elfDependencyFixture(), budget)).toThrow(
      expect.objectContaining({
        limit: { kind: "budget", parameter, value: 2, ceiling, entries },
      }),
    );
  },
);

it("reports a fixed ceiling when dynamic symbols pass it under default budgets", () => {
  const imports = Array.from({ length: 262145 }, (_, index) => ({
    name: `s${String(index)}`,
  }));
  expect(() => parse(elfDependencyFixture({ imports }))).toThrow(
    expect.objectContaining({
      limit: { kind: "ceiling", value: 262144, entries: "Dynamic symbols" },
    }),
  );
});

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

it("marks an empty PT_INTERP path unreadable with partial coverage", () => {
  const report = parse(elfDependencyFixture({ interpreter: "" }));
  expect(report.interpreter.status).toBe("unreadable");
  expect(report.coverage.status).toBe("partial");
  expect(report.issues).toContainEqual(
    expect.objectContaining({
      code: "name_unreadable",
      message: "PT_INTERP path is empty",
    }),
  );
});

it("keeps imports unresolved when two verneed entries share a version index", () => {
  const report = parse(
    elfDependencyFixture({
      verneed: [
        { file: "liba.so.1", versions: [{ name: "A_1.0", index: 2 }] },
        { file: "libb.so.1", versions: [{ name: "B_1.0", index: 2 }] },
      ],
      imports: [{ name: "shared", version: 2 }],
    }),
  );
  expect(report.coverage.status).toBe("partial");
  expect(report.version_requirements.files).toHaveLength(2);
  expect(report.imports[0]?.version).toEqual({
    index: 2,
    hidden: false,
    name: null,
    file: null,
    status: "unknown",
  });
  expect(report.issues).toContainEqual(
    expect.objectContaining({ code: "version_unresolved" }),
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
  expect(failure).toBeInstanceOf(ArtifactReaderFailure);
  expect(failure).toMatchObject({ reason: "limit", boundary: "memory" });
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
