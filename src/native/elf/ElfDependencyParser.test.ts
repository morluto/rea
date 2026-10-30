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

it("keeps readable names and marks truncated dynstr coverage partial", () => {
  const report = parse(elfDependencyFixture({ truncateDynstr: true }));
  expect(report.coverage.status).toBe("partial");
  expect(report.issues.some((issue) => issue.code === "name_unreadable")).toBe(
    true,
  );
  expect(report.needed.map((entry) => entry.name)).toEqual(defaultNeeded);
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
