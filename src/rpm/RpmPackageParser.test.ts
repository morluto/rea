import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  inspectRpmPackageInputSchema,
  rpmPackageSchema,
} from "../domain/rpm/package.js";
import { ParseFailureError } from "../domain/parseFailure.js";
import { RpmPackageCapacityFailure } from "./RpmPackage.errors.js";
import {
  encodeRpmPackage,
  rpmBinaryPackageFixture,
  rpmGroupedTriggerFixture,
  rpmInt32PreinFixture,
  rpmInvalidUtf8FilenameFixture,
  rpmLongFileSizesFixture,
  rpmMismatchedFileModesFixture,
  rpmMismatchedTriggerProgFixture,
  rpmDuplicateTagFixture,
  rpmMalformedDigestFixture,
  rpmOverlappingStringTagsFixture,
  rpmOutOfBoundsIndexFixture,
  rpmUnknownBinTagsFixture,
  rpmSourcePackageFixture,
  rpmSparsePackageFixture,
  rpmTruncatedHeaderFixture,
  rpmTruncatedMainHeaderFixture,
  rpmUtf8PackageFixture,
  RPM_SENSE,
  RPM_SIG_TAG,
  RPM_TAG,
  RPM_TYPE,
} from "./RpmPackage.fixture.js";
import {
  parseRpmPackage,
  RPM_PACKAGE_LIMITATIONS,
} from "./RpmPackageParser.js";

const defaults = inspectRpmPackageInputSchema.parse({
  path: "/artifacts/demo.rpm",
});

const identity = (bytes: Buffer) => ({
  path: defaults.path,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
});

const parse = (bytes: Buffer, input = defaults) => {
  const report = parseRpmPackage(bytes, identity(bytes), input);
  const validated = rpmPackageSchema.safeParse(report);
  if (!validated.success) throw new Error(validated.error.message);
  return report;
};

it("reads lead identity, NEVRA, flagged dependencies, scriptlets and header files", () => {
  const bytes = rpmBinaryPackageFixture();
  const report = parse(bytes);
  expect(report.lead).toMatchObject({
    magic: "edabeedb",
    type: "binary",
    name: "demo-1.0.0-1",
    signature_type: 5,
  });
  expect(report.package).toMatchObject({
    name: "demo",
    version: "1.0.0",
    release: "1",
    epoch: 2,
    arch: "noarch",
    os: "linux",
    license: "MIT",
    payload_format: "cpio",
    payload_compressor: "gzip",
  });
  expect(report.signature?.sha256_header).toHaveLength(64);
  expect(report.signature?.md5).toHaveLength(32);
  expect(report.signature?.blobs).toEqual([
    expect.objectContaining({
      tag: "rsa",
      algorithm: "rsa",
      key_id: "a1b2c3d4e5f60708",
    }),
  ]);
  expect(report.requires).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "rpmlib(CompressedFileNames)",
        comparison: "=",
        rpmlib: true,
      }),
      expect.objectContaining({
        name: "/bin/sh",
        scriptlet_only: true,
      }),
      expect.objectContaining({
        name: "libc.so.6",
        comparison: ">=",
        version: "2.17",
      }),
    ]),
  );
  expect(report.conflicts?.[0]).toMatchObject({
    name: "demo-old",
    comparison: "<",
  });
  expect(report.scriptlets?.map((row) => row.kind)).toEqual([
    "prein",
    "postin",
    "trigger",
  ]);
  expect(report.scriptlets?.every((row) => row.text === null)).toBe(true);
  expect(report.files?.map((row) => row.path)).toEqual([
    "/usr/bin/demo",
    "/etc/demo.conf",
  ]);
  expect(report.files?.[1]).toMatchObject({
    config: true,
    digest_algorithm: "sha256",
  });
  expect(report.payload).toMatchObject({
    listing_source: "header",
    compressor: "gzip",
    format: "cpio",
  });
  expect(report.payload.offset + report.payload.size).toBe(
    report.artifact.bytes,
  );
  expect(report.header.immutable_region).toEqual(
    expect.objectContaining({ present: true, bytes: 16 }),
  );
  expect(report.coverage.status).toBe("complete");
  expect(report.limitations).toEqual(
    expect.arrayContaining([...RPM_PACKAGE_LIMITATIONS]),
  );
});

it("marks Requires(pretrans) and Requires(posttrans) rows as scriptlet-only", () => {
  const bytes = rpmBinaryPackageFixture({
    headerTags: [
      { tag: RPM_TAG.name, type: RPM_TYPE.string, string: "transdeps" },
      { tag: RPM_TAG.version, type: RPM_TYPE.string, string: "0.1" },
      { tag: RPM_TAG.release, type: RPM_TYPE.string, string: "1" },
      { tag: RPM_TAG.arch, type: RPM_TYPE.string, string: "noarch" },
      {
        tag: RPM_TAG.requireName,
        type: RPM_TYPE.stringArray,
        strings: ["/usr/bin/pre-tool", "/usr/bin/post-tool", "libc.so.6"],
      },
      {
        tag: RPM_TAG.requireFlags,
        type: RPM_TYPE.int32,
        int32: [RPM_SENSE.pretrans, RPM_SENSE.posttrans, 0],
      },
      { tag: RPM_TAG.payloadFormat, type: RPM_TYPE.string, string: "cpio" },
      { tag: RPM_TAG.payloadCompressor, type: RPM_TYPE.string, string: "gzip" },
    ],
  });
  const report = parse(bytes);
  expect(
    report.requires?.map(({ name, flags, scriptlet_only }) => ({
      name,
      flags,
      scriptlet_only,
    })),
  ).toEqual([
    { name: "/usr/bin/pre-tool", flags: 0x80, scriptlet_only: true },
    { name: "/usr/bin/post-tool", flags: 0x20, scriptlet_only: true },
    { name: "libc.so.6", flags: 0, scriptlet_only: false },
  ]);
});

it("returns scriptlet text only when the caller opts in", () => {
  const bytes = rpmBinaryPackageFixture();
  const report = parse(
    bytes,
    inspectRpmPackageInputSchema.parse({
      path: defaults.path,
      include_script_text: true,
    }),
  );
  expect(report.scriptlets?.find((row) => row.kind === "prein")).toMatchObject({
    interpreter: "/bin/sh",
    text: "echo prein\n",
  });
});

it("decodes UTF-8 header text and reports stored byte lengths", () => {
  const bytes = rpmUtf8PackageFixture();
  expect(bytes.includes(Buffer.from("Café résumé tool", "utf8"))).toBe(true);
  const report = parse(
    bytes,
    inspectRpmPackageInputSchema.parse({
      path: defaults.path,
      include_script_text: true,
    }),
  );
  expect(report.package.summary).toBe("Café résumé tool");
  expect(report.files?.map((row) => row.path)).toEqual([
    "/usr/share/café/naïve.txt",
  ]);
  const prein = report.scriptlets?.find((row) => row.kind === "prein");
  expect(prein?.text).toBe("echo é\n");
  // "echo é\n" is 7 characters but 8 UTF-8 bytes in the data store.
  expect(prein?.bytes).toBe(8);
});

it("refuses an invalid UTF-8 filename with its raw bytes instead of replacing them", () => {
  const bytes = rpmInvalidUtf8FilenameFixture();
  expect(() => parseRpmPackage(bytes, identity(bytes), defaults)).toThrow(
    ParseFailureError,
  );
  try {
    parseRpmPackage(bytes, identity(bytes), defaults);
  } catch (cause) {
    if (!(cause instanceof ParseFailureError)) throw cause;
    expect(cause.failure).toMatchObject({
      kind: "malformed",
      format: "rpm",
      field: "main tag 1117",
      observed: { signature: { size: 256 } },
    });
    expect(cause.message).toMatch(/tag 1117\[1\] is not valid UTF-8/u);
    expect(cause.message).toContain(
      Buffer.from("caf\xe9.txt", "latin1").toString("hex"),
    );
    expect(cause.message).not.toContain("\uFFFD");
  }
});

it("reports invalid UTF-8 scriptlet bytes without decoding text it omits", () => {
  const bytes = rpmBinaryPackageFixture({
    headerTags: [
      { tag: RPM_TAG.name, type: RPM_TYPE.string, string: "latin1script" },
      {
        tag: RPM_TAG.prein,
        type: RPM_TYPE.string,
        count: 1,
        bin: Buffer.from("echo \xe9\n\0", "latin1"),
      },
      // DESCRIPTION is not reported, so its bytes are never decoded.
      {
        tag: 1005,
        type: RPM_TYPE.i18nString,
        count: 1,
        bin: Buffer.from("r\xe9sum\xe9\0", "latin1"),
      },
    ],
  });
  const report = parse(bytes);
  expect(report.scriptlets).toEqual([
    expect.objectContaining({ kind: "prein", bytes: 7, text: null }),
  ]);
  expect(() =>
    parse(
      bytes,
      inspectRpmPackageInputSchema.parse({
        path: defaults.path,
        include_script_text: true,
      }),
    ),
  ).toThrow(/tag 1023 is not valid UTF-8/u);
});

it("groups every TRIGGERNAME condition under the script TRIGGERINDEX names", () => {
  const triggers = parse(rpmGroupedTriggerFixture()).scriptlets?.filter(
    (row) => row.kind === "trigger",
  );
  expect(
    triggers?.map((row) => ({
      interpreter: row.interpreter,
      trigger_names: row.trigger_names,
    })),
  ).toEqual([
    { interpreter: "/bin/sh", trigger_names: ["foo", "bar"] },
    { interpreter: "/bin/bash", trigger_names: ["baz"] },
  ]);
});

it("refuses a TRIGGERINDEX outside TRIGGERSCRIPTS as malformed", () => {
  try {
    parse(rpmGroupedTriggerFixture([0, 0, 2]));
    throw new Error("expected trigger index refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(ParseFailureError);
    if (!(cause instanceof ParseFailureError)) return;
    expect(cause.failure).toMatchObject({
      kind: "malformed",
      format: "rpm",
      field: "trigger index",
    });
    expect(cause.message).toMatch(/TRIGGERINDEX\[2\] 2 is outside/u);
  }
});

it("keeps source RPMs distinct from binary packages", () => {
  const report = parse(rpmSourcePackageFixture());
  expect(report.lead.type).toBe("source");
  expect(report.package.arch).toBe("src");
  expect(report.files?.[0]?.path).toBe("demo.spec");
});

it("keeps missing optional tags null rather than empty or zero", () => {
  const report = parse(rpmSparsePackageFixture());
  expect(report.package.epoch).toBeNull();
  expect(report.package.license).toBeNull();
  expect(report.package.vendor).toBeNull();
  expect(report.requires).toBeNull();
  expect(report.recommends).toBeNull();
  expect(report.scriptlets).toBeNull();
  expect(report.files).toBeNull();
  expect(report.coverage.files).toBeNull();
  expect(report.package.payload_compressor).toBe("zstd");
});

it("keeps dependency and file flags null when their flags tags are absent", () => {
  const bytes = rpmBinaryPackageFixture({
    headerTags: [
      { tag: RPM_TAG.name, type: RPM_TYPE.string, string: "noflags" },
      { tag: RPM_TAG.version, type: RPM_TYPE.string, string: "0.1" },
      { tag: RPM_TAG.release, type: RPM_TYPE.string, string: "1" },
      { tag: RPM_TAG.arch, type: RPM_TYPE.string, string: "noarch" },
      {
        tag: RPM_TAG.requireName,
        type: RPM_TYPE.stringArray,
        strings: ["rpmlib(CompressedFileNames)", "libc.so.6"],
      },
      { tag: RPM_TAG.dirNames, type: RPM_TYPE.stringArray, strings: ["/etc/"] },
      {
        tag: RPM_TAG.baseNames,
        type: RPM_TYPE.stringArray,
        strings: ["noflags.conf"],
      },
      { tag: RPM_TAG.dirIndexes, type: RPM_TYPE.int32, int32: [0] },
      { tag: RPM_TAG.payloadFormat, type: RPM_TYPE.string, string: "cpio" },
      { tag: RPM_TAG.payloadCompressor, type: RPM_TYPE.string, string: "gzip" },
    ],
  });
  const report = parse(bytes);
  expect(report.requires).toEqual([
    {
      name: "rpmlib(CompressedFileNames)",
      version: null,
      flags: null,
      comparison: null,
      rpmlib: true,
      scriptlet_only: null,
    },
    {
      name: "libc.so.6",
      version: null,
      flags: null,
      comparison: null,
      rpmlib: false,
      scriptlet_only: null,
    },
  ]);
  expect(report.files?.[0]).toMatchObject({
    path: "/etc/noflags.conf",
    flags: null,
    config: null,
    doc: null,
  });
});

it("preserves epoch zero when the tag is present", () => {
  const bytes = encodeRpmPackage({
    headerTags: [
      { tag: RPM_TAG.name, type: RPM_TYPE.string, string: "zero" },
      { tag: RPM_TAG.epoch, type: RPM_TYPE.int32, int32: [0] },
    ],
  });
  expect(parse(bytes).package.epoch).toBe(0);
});

it("keeps omitted signature digests null", () => {
  const bytes = encodeRpmPackage({
    signatureTags: [
      { tag: RPM_SIG_TAG.size, type: RPM_TYPE.int32, int32: [1] },
    ],
  });
  const report = parse(bytes);
  expect(report.signature?.md5).toBeNull();
  expect(report.signature?.sha1_header).toBeNull();
  expect(report.signature?.sha256_header).toBeNull();
  expect(report.signature?.blobs).toEqual([]);
});

it("reports a truncated header as truncated and keeps the lead", () => {
  try {
    parse(rpmTruncatedHeaderFixture());
    throw new Error("expected truncated header refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(ParseFailureError);
    if (!(cause instanceof ParseFailureError)) return;
    expect(cause.failure).toMatchObject({
      kind: "truncated",
      format: "rpm",
      observed: { lead: { magic: "edabeedb", type: "binary" } },
    });
  }
});

it("keeps read signature facts when the main header is truncated", () => {
  try {
    parse(rpmTruncatedMainHeaderFixture());
    throw new Error("expected truncated main header refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(ParseFailureError);
    if (!(cause instanceof ParseFailureError)) return;
    expect(cause.failure).toMatchObject({
      kind: "truncated",
      format: "rpm",
      observed: {
        lead: { magic: "edabeedb" },
        signature: {
          size: 256,
          md5: "ee".repeat(16),
          sha1_header: "cd".repeat(20),
          sha256_header: "ab".repeat(32),
          payload_digest: "ef".repeat(32),
          payload_digest_algorithm: 8,
          blobs: [{ present: true, tag: "rsa", key_id: "a1b2c3d4e5f60708" }],
        },
      },
    });
  }
});

it("reports a short lead as truncated rather than malformed", () => {
  try {
    parse(rpmBinaryPackageFixture().subarray(0, 40));
    throw new Error("expected truncated lead refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(ParseFailureError);
    if (!(cause instanceof ParseFailureError)) return;
    expect(cause.failure).toMatchObject({
      kind: "truncated",
      format: "rpm",
      observed: { lead: { magic: "edabeedb" } },
    });
  }
});

const malformedRefusal = (bytes: Buffer): ParseFailureError => {
  try {
    parse(bytes);
  } catch (cause) {
    if (cause instanceof ParseFailureError) return cause;
    throw cause;
  }
  throw new Error("expected a malformed refusal");
};

it("refuses an in-bounds PREIN stored as INT32 instead of dropping the scriptlet", () => {
  const cause = malformedRefusal(rpmInt32PreinFixture());
  expect(cause.failure).toMatchObject({
    kind: "malformed",
    format: "rpm",
    field: "main tag 1023",
    observed: { signature: { size: 256 } },
  });
  expect(cause.message).toMatch(
    /tag 1023 \(PREIN\) is stored as INT32; expected STRING/u,
  );
});

it("refuses a fixed-count tag whose stored count differs", () => {
  const epoch = malformedRefusal(
    encodeRpmPackage({
      headerTags: [
        { tag: RPM_TAG.name, type: RPM_TYPE.string, string: "twoepochs" },
        { tag: RPM_TAG.epoch, type: RPM_TYPE.int32, int32: [1, 2] },
      ],
    }),
  );
  expect(epoch.failure).toMatchObject({
    kind: "malformed",
    field: "main tag 1003",
  });
  expect(epoch.message).toMatch(/\(EPOCH\) has count 2; expected 1/u);
  const md5 = malformedRefusal(
    encodeRpmPackage({
      signatureTags: [
        { tag: RPM_SIG_TAG.md5, type: RPM_TYPE.bin, bin: Buffer.alloc(8) },
      ],
    }),
  );
  expect(md5.failure).toMatchObject({
    kind: "malformed",
    field: "signature tag 1004",
  });
  expect(md5.message).toMatch(/\(SIG_MD5\) has count 8; expected 16/u);
});

it("refuses an index entry that leaves the data store", () => {
  try {
    parse(rpmOutOfBoundsIndexFixture());
    throw new Error("expected out-of-bounds index refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(ParseFailureError);
    if (!(cause instanceof ParseFailureError)) return;
    expect(cause.kind).toBe("malformed");
    expect(cause.message).toMatch(/outside the data store/u);
  }
});

it("refuses a foreign magic as unsupported rather than a parse", () => {
  const bytes = Buffer.from(rpmBinaryPackageFixture());
  bytes.writeUInt32BE(0xdeadbeef, 0);
  try {
    parse(bytes);
    throw new Error("expected unsupported magic");
  } catch (cause) {
    expect(cause).toBeInstanceOf(ParseFailureError);
    if (!(cause instanceof ParseFailureError)) return;
    expect(cause.kind).toBe("unsupported");
  }
});

it("refuses header index counts above the caller budget", () => {
  try {
    parse(
      rpmBinaryPackageFixture(),
      inspectRpmPackageInputSchema.parse({
        path: defaults.path,
        max_header_index_entries: 1,
      }),
    );
    throw new Error("expected index budget refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(RpmPackageCapacityFailure);
    if (!(cause instanceof RpmPackageCapacityFailure)) return;
    expect(cause.resource).toBe("max_header_index_entries");
  }
});

it("refuses a header index that runs past the file as truncation, not a budget", () => {
  const bytes = Buffer.from(rpmBinaryPackageFixture().subarray(0, 96 + 64));
  // Signature header index count, 8 bytes after the 96-byte lead.
  bytes.writeUInt32BE(0xffffffff, 96 + 8);
  try {
    parse(bytes);
    throw new Error("expected truncation refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(ParseFailureError);
    if (!(cause instanceof ParseFailureError)) return;
    expect(cause.kind).toBe("truncated");
  }
});

it("refuses file inventories above the caller budget", () => {
  try {
    parse(
      rpmBinaryPackageFixture(),
      inspectRpmPackageInputSchema.parse({
        path: defaults.path,
        max_files: 1,
      }),
    );
    throw new Error("expected file budget refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(RpmPackageCapacityFailure);
    if (!(cause instanceof RpmPackageCapacityFailure)) return;
    expect(cause.resource).toBe("max_files");
  }
});

it("refuses a per-file array above the file budget before building its rows", () => {
  const bytes = encodeRpmPackage({
    headerTags: [
      { tag: RPM_TAG.name, type: RPM_TYPE.string, string: "rows" },
      { tag: RPM_TAG.version, type: RPM_TYPE.string, string: "1" },
      { tag: RPM_TAG.release, type: RPM_TYPE.string, string: "1" },
      { tag: RPM_TAG.arch, type: RPM_TYPE.string, string: "noarch" },
      {
        tag: RPM_TAG.baseNames,
        type: RPM_TYPE.stringArray,
        strings: Array.from({ length: 64 }, () => ""),
      },
    ],
  });
  try {
    parse(
      bytes,
      inspectRpmPackageInputSchema.parse({ path: defaults.path, max_files: 8 }),
    );
    throw new Error("expected file budget refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(RpmPackageCapacityFailure);
    if (!(cause instanceof RpmPackageCapacityFailure)) return;
    expect(cause.resource).toBe("max_files");
    expect(cause.message).toContain("BASENAMES declares 64 rows");
  }
});

it.each([
  [
    "FILEMODES",
    { tag: RPM_TAG.fileModes, type: RPM_TYPE.int16, int16: [0o100644] },
  ],
  [
    "BASENAMES",
    { tag: RPM_TAG.baseNames, type: RPM_TYPE.stringArray, strings: ["a"] },
  ],
])(
  "refuses a %s count its stored bytes cannot hold as malformed, not a file budget",
  (_, tag) => {
    const bytes = encodeRpmPackage({
      headerTags: [
        { tag: RPM_TAG.name, type: RPM_TYPE.string, string: "rows" },
        { tag: RPM_TAG.version, type: RPM_TYPE.string, string: "1" },
        { tag: RPM_TAG.release, type: RPM_TYPE.string, string: "1" },
        { tag: RPM_TAG.arch, type: RPM_TYPE.string, string: "noarch" },
        // Above the default max_files, with one stored value.
        { ...tag, count: 2_000_000 },
      ],
    });
    expect(2_000_000).toBeGreaterThan(defaults.max_files);
    try {
      parse(bytes);
      throw new Error("expected malformed extent refusal");
    } catch (cause) {
      expect(cause).not.toBeInstanceOf(RpmPackageCapacityFailure);
      expect(cause).toBeInstanceOf(ParseFailureError);
      if (!(cause instanceof ParseFailureError)) return;
      expect(cause.kind).toBe("malformed");
      expect(cause.message).toMatch(/value leaves the data store/u);
    }
  },
);

it("refuses file paths that expand past the read budget through a shared directory", () => {
  const directory = `/${"d".repeat(1023)}`;
  const baseNames = Array.from(
    { length: 64 },
    (_, index) => `f${String(index)}`,
  );
  const bytes = rpmBinaryPackageFixture({
    headerTags: [
      { tag: RPM_TAG.name, type: RPM_TYPE.string, string: "shared" },
      { tag: RPM_TAG.version, type: RPM_TYPE.string, string: "0.1" },
      { tag: RPM_TAG.release, type: RPM_TYPE.string, string: "1" },
      { tag: RPM_TAG.arch, type: RPM_TYPE.string, string: "noarch" },
      {
        tag: RPM_TAG.dirNames,
        type: RPM_TYPE.stringArray,
        strings: [directory],
      },
      {
        tag: RPM_TAG.baseNames,
        type: RPM_TYPE.stringArray,
        strings: baseNames,
      },
      {
        tag: RPM_TAG.dirIndexes,
        type: RPM_TYPE.int32,
        int32: baseNames.map(() => 0),
      },
    ],
  });
  // The stored header holds the directory once, so the file fits the budget
  // while the 64 joined paths (over 64 KiB) do not.
  const budget = bytes.length + 4096;
  expect(budget).toBeLessThan(64 * 1024);
  try {
    parse(
      bytes,
      inspectRpmPackageInputSchema.parse({
        path: defaults.path,
        max_file_bytes: budget,
      }),
    );
    throw new Error("expected path budget refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(RpmPackageCapacityFailure);
    if (!(cause instanceof RpmPackageCapacityFailure)) return;
    expect(cause.resource).toBe("max_file_bytes");
    expect(cause.maximum).toBe(budget);
  }
  expect(parse(bytes).files).toHaveLength(64);
});

it("refuses oversize scriptlet text when the caller requested it", () => {
  try {
    parse(
      rpmBinaryPackageFixture(),
      inspectRpmPackageInputSchema.parse({
        path: defaults.path,
        include_script_text: true,
        max_script_bytes: 1,
      }),
    );
    throw new Error("expected script budget refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(RpmPackageCapacityFailure);
    if (!(cause instanceof RpmPackageCapacityFailure)) return;
    expect(cause.resource).toBe("max_script_bytes");
  }
});

it.each([
  ["FILEMODES", rpmMismatchedFileModesFixture, "file inventory"],
  [
    "TRIGGERSCRIPTPROG",
    rpmMismatchedTriggerProgFixture,
    "trigger script programs",
  ],
])(
  "refuses a %s array whose length does not match its rows",
  (_, fixture, field) => {
    try {
      parse(fixture());
      throw new Error("expected a mismatched array refusal");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ParseFailureError);
      if (!(cause instanceof ParseFailureError)) return;
      expect(cause.failure).toMatchObject({ kind: "malformed", field });
      // The saved lead and signature facts survive the refusal.
      expect(cause.failure.observed).toMatchObject({
        lead: { magic: "edabeedb" },
        signature: expect.any(Object),
      });
    }
  },
);

it("reads file sizes from LONGFILESIZES when the package stores them there", () => {
  const report = parse(rpmLongFileSizesFixture());
  expect(report.files?.map((file) => file.size)).toEqual([5_000_000_000, 12]);
});

it("refuses a repeated reported tag instead of skipping its bounds check", () => {
  expect(() => parse(rpmDuplicateTagFixture())).toThrow(
    /main header repeats tag 1000, so its value is ambiguous/u,
  );
});

it("checks unknown tags' placement without decoding their values", () => {
  expect(parse(rpmUnknownBinTagsFixture(200)).package.name).toBe("demo");
  expect(() => parse(rpmUnknownBinTagsFixture(1, 0xffff_fff0))).toThrow(
    /tag 90000 offset -16 is outside the data store/u,
  );
  expect(() => parse(rpmUnknownBinTagsFixture(1, 0, 0x10_0000))).toThrow(
    /tag 90000 value leaves the data store/u,
  );
});

it("scans the store at most once for unread string tags", () => {
  expect(parse(rpmOverlappingStringTagsFixture(1)).package.name).toBe("demo");
  expect(() => parse(rpmOverlappingStringTagsFixture(4000))).toThrow(
    /unread string tags overlap in the data store/u,
  );
});

it("refuses a header value the report cannot carry, keeping the facts read", () => {
  try {
    parse(rpmMalformedDigestFixture());
    throw new Error("expected a malformed digest refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(ParseFailureError);
    if (!(cause instanceof ParseFailureError)) return;
    expect(cause.kind).toBe("malformed");
    expect(cause.failure.observed).toMatchObject({
      lead: { magic: "edabeedb" },
    });
  }
});
