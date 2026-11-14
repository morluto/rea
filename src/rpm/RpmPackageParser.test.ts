import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  inspectRpmPackageInputSchema,
  rpmPackageSchema,
} from "../domain/rpm/package.js";
import {
  RpmPackageCapacityFailure,
  RpmPackageFormatFailure,
} from "./RpmPackage.errors.js";
import {
  encodeRpmPackage,
  rpmBinaryPackageFixture,
  rpmOutOfBoundsIndexFixture,
  rpmSourcePackageFixture,
  rpmSparsePackageFixture,
  rpmTruncatedHeaderFixture,
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

it("refuses a truncated header and keeps the lead", () => {
  try {
    parse(rpmTruncatedHeaderFixture());
    throw new Error("expected truncated header refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(RpmPackageFormatFailure);
    if (!(cause instanceof RpmPackageFormatFailure)) return;
    expect(cause.kind).toBe("malformed");
    expect(cause.observed).toMatchObject({
      lead: { magic: "edabeedb", type: "binary" },
    });
  }
});

it("refuses an index entry that leaves the data store", () => {
  try {
    parse(rpmOutOfBoundsIndexFixture());
    throw new Error("expected out-of-bounds index refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(RpmPackageFormatFailure);
    if (!(cause instanceof RpmPackageFormatFailure)) return;
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
    expect(cause).toBeInstanceOf(RpmPackageFormatFailure);
    if (!(cause instanceof RpmPackageFormatFailure)) return;
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
