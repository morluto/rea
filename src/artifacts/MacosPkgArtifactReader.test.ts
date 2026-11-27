import { createHash } from "node:crypto";
import { buffer } from "node:stream/consumers";
import { Readable } from "node:stream";
import { deflateSync, gzipSync, inflateSync } from "node:zlib";

import { expect, it, vi } from "vitest";

import { collectEntries } from "../../tests/fixtures/artifactEntries.js";
import { createTestTempFile } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import { ARTIFACT_COMPARISON_EXAMPLE } from "../contracts/artifactComparisonExample.js";
import { compareArtifacts } from "../domain/artifactComparison.js";
import { createEvidence } from "../domain/evidence.js";
import {
  MACOS_PKG_MAX_CPIO_MEMBERS,
  MACOS_PKG_MAX_METADATA_RECORDS,
  MACOS_PKG_MAX_TOC_PATH_BYTES,
  MACOS_PKG_MAX_TOTAL_METADATA_XML_BYTES,
} from "../domain/macosPkgFormat.js";
import { ArtifactEntryContentUnavailable } from "../resources/ArtifactReader.js";
import { MacosPkgArtifactReader } from "./MacosPkgArtifactReader.js";
import { parseXarHeader } from "./macosPkg/XarHeader.js";
import {
  createBoundedXarInflate,
  inflateXarMemberBytes,
} from "./macosPkg/XarInflate.js";

vi.mock("./macosPkg/XarInflate.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./macosPkg/XarInflate.js")>();
  return {
    ...actual,
    inflateXarMemberBytes: vi.fn(actual.inflateXarMemberBytes),
    createBoundedXarInflate: vi.fn(actual.createBoundedXarInflate),
  };
});
import {
  buildBadCpioPackage,
  buildBadInflatePackage,
  buildComponentPackage,
  buildDuplicatePathPackage,
  buildExpandingPayloadsProductArchive,
  buildExtractedSizeMismatchGzipPackage,
  buildGzipPackageInfo,
  buildHeapOutOfBoundsPackage,
  buildMultiComponentProductArchive,
  buildOversizeArchivedGzipPackage,
  buildOversizeArchivedUnsupportedPackage,
  buildOversizeDeclaredGzipPackage,
  buildOversizeTocPackage,
  buildPbzxPayloadPackage,
  buildProductArchive,
  buildSignedProductArchive,
  buildSpecialMemberPayloadPackage,
  buildTocPastEofPackage,
  truncatedPkgHeader,
  buildCpioOdc,
  buildXar,
} from "./macosPkg/MacosPkg.fixture.js";
import { CPIO_ODC_HEADER_BYTES, parseCpioOdc } from "./macosPkg/CpioOdc.js";

const writePkg = (name: string, bytes: Buffer): Promise<string> =>
  createTestTempFile("rea-macos-pkg-", name, bytes);

const entriesOf = async (
  bytes: Buffer,
  name = "fixture.pkg",
  expandedBytes?: number,
) => {
  const path = await writePkg(name, bytes);
  const reader = new MacosPkgArtifactReader(path, undefined, expandedBytes);
  try {
    const entries = [];
    const coverage: unknown[] = [];
    for await (const entry of reader.entries(undefined, {
      onCoverage: (value) => coverage.push(value),
    }))
      entries.push(entry);
    return { reader, entries, coverage, path };
  } catch (cause: unknown) {
    await reader.close();
    throw cause;
  }
};

it("round-trips odc cpio members including a symlink", () => {
  const archive = buildCpioOdc([
    { name: "hello.txt", mode: 0o100644, data: Buffer.from("hi") },
    { name: "link", mode: 0o120777, data: Buffer.from("hello.txt") },
  ]);
  const parsed = parseCpioOdc(archive);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value).toMatchObject([
    {
      name: "hello.txt",
      kind: "file",
      size: 2,
    },
    {
      name: "link",
      kind: "symlink",
      symlinkTarget: "hello.txt",
    },
  ]);
});

it("inventories a product archive's Distribution, scripts and payload", async () => {
  const { reader, entries, coverage } = await entriesOf(buildProductArchive());
  try {
    expect(reader.formatMetadata()).toMatchObject({
      kind: "macos-pkg",
      archive_kind: "product",
      xar: { magic: "xar!", version: 1, checksum_algorithm: "sha1" },
      signature: { present: false, verification: "not_verified" },
      distribution: {
        title: "REA Fixture",
        pkg_refs: [
          expect.objectContaining({
            id: "com.rea.fixture.component",
            version: "1.0.0",
            install_kbytes: 1,
          }),
        ],
        choices: ["default", "component"],
        allowed_os_versions: [{ min: "13.0", max: null }],
        installation_check_script_bytes: expect.any(Number),
        volume_check_script_bytes: expect.any(Number),
      },
      packages: [
        expect.objectContaining({
          identifier: "com.rea.fixture.component",
          version: "1.0.0",
          install_location: "/",
          auth: "root",
          preinstall: "./preinstall",
          postinstall: "./postinstall",
        }),
      ],
      scripts: {
        present: true,
        compression: "gzip-cpio-odc",
        preinstall: true,
        postinstall: true,
      },
      payload: { present: true, compression: "gzip-cpio-odc" },
      bom: { present: true, path: "Component.pkg/Bom" },
    });
    expect(coverage).toEqual([expect.objectContaining({ status: "complete" })]);
    const paths = entries.map((entry) => entry.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "Distribution",
        "Component.pkg/PackageInfo",
        "Component.pkg/Bom",
        "Component.pkg/Scripts/preinstall",
        "Component.pkg/Scripts/postinstall",
        "Component.pkg/Payload/usr/local/rea/hello.txt",
        "Component.pkg/Payload/usr/local/rea/link",
      ]),
    );
    const hello = entries.find(
      (entry) => entry.path === "Component.pkg/Payload/usr/local/rea/hello.txt",
    );
    expect(hello?.formatMetadata).toMatchObject({
      kind: "macos-pkg-entry",
      role: "payload-member",
      uid: 0,
      gid: 0,
    });
    const link = entries.find(
      (entry) => entry.path === "Component.pkg/Payload/usr/local/rea/link",
    );
    expect(link).toMatchObject({
      kind: "symlink",
      formatMetadata: expect.objectContaining({ symlink_target: "hello.txt" }),
    });
    expect((await buffer(await reader.open(hello!))).toString("utf8")).toBe(
      "hello from payload\n",
    );
    for (const role of ["Scripts", "Payload"]) {
      const stored = entries.find(
        (entry) => entry.sourcePath === `Component.pkg/${role}`,
      );
      expect(stored).toMatchObject({
        path: `Component.pkg/${role}.cpio.gz`,
        kind: "file",
        byteOffset: expect.any(Number),
        formatMetadata: expect.objectContaining({
          role: "xar-file",
          archived_checksum: expect.anything(),
          extracted_checksum: expect.anything(),
        }),
      });
      const bytes = await buffer(await reader.open(stored!));
      expect(bytes.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))).toBe(true);
    }
  } finally {
    await reader.close();
  }
});

it("inventories a component-only package", async () => {
  const { reader, entries } = await entriesOf(buildComponentPackage());
  try {
    expect(reader.formatMetadata()).toMatchObject({
      archive_kind: "component",
      distribution: null,
      packages: [
        expect.objectContaining({ identifier: "com.rea.fixture.component" }),
      ],
    });
    expect(entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        "PackageInfo",
        "Payload/usr/local/rea/hello.txt",
      ]),
    );
  } finally {
    await reader.close();
  }
});

it("reports a signed TOC without claiming the signature is valid", async () => {
  const { reader } = await entriesOf(buildSignedProductArchive());
  try {
    expect(reader.formatMetadata()?.signature).toMatchObject({
      present: true,
      toc_signature: true,
      algorithm: "RSA",
      certificate_count: 1,
      certificates: [
        { subject_cn: "REA Test Packager", issuer_cn: "REA Test Packager" },
      ],
      verification: "not_verified",
    });
  } finally {
    await reader.close();
  }
});

it("refuses pbzx payload expansion while keeping PackageInfo and Scripts", async () => {
  const { reader, entries, coverage } = await entriesOf(
    buildPbzxPayloadPackage(),
  );
  try {
    expect(coverage).toEqual([expect.objectContaining({ status: "unknown" })]);
    const metadata = reader.formatMetadata();
    expect(metadata?.payload).toMatchObject({
      present: true,
      compression: "pbzx",
      members: [],
    });
    expect(metadata?.refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unsupported-compression" }),
      ]),
    );
    expect(metadata?.scripts.preinstall).toBe(true);
    expect(entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["PackageInfo", "Scripts/preinstall", "Payload"]),
    );
    expect(entries.map((entry) => entry.path)).not.toContain(
      "Payload/usr/local/rea/hello.txt",
    );
  } finally {
    await reader.close();
  }
});

it("keeps a truncated xar header as a typed refusal", async () => {
  const { reader, entries, coverage } = await entriesOf(
    truncatedPkgHeader(),
    "truncated.pkg",
  );
  try {
    expect(entries).toEqual([]);
    expect(reader.formatMetadata()?.refusals).toEqual([
      expect.objectContaining({ code: "truncated-header" }),
    ]);
    expect(coverage).toEqual([expect.objectContaining({ status: "unknown" })]);
  } finally {
    await reader.close();
  }
});

it("keeps the header when the TOC length extends past EOF", async () => {
  const { reader } = await entriesOf(buildTocPastEofPackage(), "past-eof.pkg");
  try {
    expect(reader.formatMetadata()).toMatchObject({
      xar: { header_size: 28, toc_compressed_length: 1024 },
      refusals: [expect.objectContaining({ code: "toc-past-eof" })],
    });
  } finally {
    await reader.close();
  }
});

it("keeps the header when TOC inflate fails", async () => {
  const { reader } = await entriesOf(
    buildBadInflatePackage(),
    "bad-inflate.pkg",
  );
  try {
    expect(reader.formatMetadata()?.refusals).toEqual([
      expect.objectContaining({ code: "toc-inflate" }),
    ]);
  } finally {
    await reader.close();
  }
});

it("keeps other members when a heap range is out of bounds", async () => {
  const { reader, entries, coverage } = await entriesOf(
    buildHeapOutOfBoundsPackage(),
    "heap-oob.pkg",
  );
  try {
    expect(coverage).toEqual([expect.objectContaining({ status: "unknown" })]);
    expect(reader.formatMetadata()?.refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "heap-out-of-bounds" }),
      ]),
    );
    expect(
      entries.find((entry) => entry.path === "PackageInfo"),
    ).toBeUndefined();
  } finally {
    await reader.close();
  }
});

it("keeps PackageInfo when Payload cpio headers are garbage", async () => {
  const { reader, entries, coverage } = await entriesOf(
    buildBadCpioPackage(),
    "bad-cpio.pkg",
  );
  try {
    expect(coverage).toEqual([expect.objectContaining({ status: "unknown" })]);
    expect(reader.formatMetadata()?.refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "cpio-malformed" }),
      ]),
    );
    expect(entries.map((entry) => entry.path)).toContain("PackageInfo");
  } finally {
    await reader.close();
  }
});

it("keeps members read before a damaged cpio tail next to the refusal", async () => {
  const complete = buildCpioOdc([
    { name: "preinstall", mode: 0o100755, data: Buffer.from("#!/bin/sh\n") },
  ]);
  // Drop the TRAILER!!! record so the archive ends after a complete member.
  const trailerless = complete.subarray(0, complete.indexOf("070707", 1));
  const { reader, entries, coverage } = await entriesOf(
    buildXar({
      files: [
        { path: "PackageInfo", bytes: Buffer.from("<pkg-info/>") },
        { path: "Scripts", bytes: gzipSync(trailerless) },
      ],
    }),
    "damaged-tail.pkg",
  );
  try {
    const metadata = reader.formatMetadata();
    expect(metadata?.scripts).toMatchObject({
      present: true,
      compression: "gzip-cpio-odc",
      preinstall: true,
      members: [expect.objectContaining({ name: "preinstall" })],
    });
    expect(metadata?.refusals).toEqual([
      expect.objectContaining({
        path: "Scripts",
        message: expect.stringContaining("header is truncated"),
      }),
    ]);
    expect(entries.map((entry) => entry.path)).toContain("Scripts/preinstall");
    expect(coverage).toEqual([expect.objectContaining({ status: "unknown" })]);
  } finally {
    await reader.close();
  }
});

it("rejects a cpio trailer that declares a member body", () => {
  const archive = buildCpioOdc([]);
  archive.write("00000000001", 65, "ascii");
  expect(parseCpioOdc(archive)).toMatchObject({
    ok: false,
    error: {
      message: expect.stringContaining("trailer declares a non-zero size"),
    },
  });
});

it.each([
  { name: "stored", wrap: (bytes: Buffer) => bytes },
  { name: "gzip", wrap: gzipSync },
])(
  "keeps prior package members when a $name cpio has bytes after its trailer",
  async ({ wrap }) => {
    const archive = buildCpioOdc([
      { name: "preinstall", mode: 0o100755, data: Buffer.from("fixture") },
    ]);
    const padding = Buffer.alloc(512);
    const tail = buildCpioOdc([
      { name: "postinstall", mode: 0o100755, data: Buffer.from("fixture") },
    ]);
    const { reader, coverage, entries } = await entriesOf(
      buildXar({
        files: [
          { path: "Payload", bytes: wrap(Buffer.concat([archive, padding])) },
          {
            path: "Scripts",
            bytes: wrap(Buffer.concat([archive, padding, tail])),
          },
        ],
      }),
      "cpio-tail.pkg",
    );
    try {
      expect(entries.map((entry) => entry.path)).toEqual(
        expect.arrayContaining(["Payload/preinstall", "Scripts/preinstall"]),
      );
      expect(
        entries.some((entry) => entry.path === "Scripts/postinstall"),
      ).toBe(false);
      expect(reader.formatMetadata()?.refusals).toEqual([
        expect.objectContaining({
          path: "Scripts",
          code: "cpio-malformed",
          message: expect.stringContaining(
            `non-zero data at offset ${String(archive.length + padding.length)}`,
          ),
        }),
      ]);
      expect(coverage).toEqual([
        expect.objectContaining({ status: "unknown" }),
      ]);
    } finally {
      await reader.close();
    }
  },
);

it.each([
  { name: "stored", wrap: (bytes: Buffer) => bytes },
  { name: "gzip", wrap: gzipSync },
])(
  "keeps prior members when a $name cpio hides bytes in its trailer name",
  async ({ wrap }) => {
    const archive = buildCpioOdc([
      { name: "preinstall", mode: 0o100755, data: Buffer.from("fixture") },
    ]);
    const nameOffset = archive.length - Buffer.byteLength("TRAILER!!!\0");
    const trailerName = Buffer.from("TRAILER!!!\0X");
    const malformed = Buffer.concat([
      archive.subarray(0, nameOffset),
      trailerName,
    ]);
    malformed.write(
      trailerName.length.toString(8).padStart(6, "0"),
      nameOffset - CPIO_ODC_HEADER_BYTES + 59,
      "ascii",
    );
    const { reader, coverage, entries } = await entriesOf(
      buildXar({
        files: [
          { path: "Payload", bytes: wrap(archive) },
          { path: "Scripts", bytes: wrap(malformed) },
        ],
      }),
      "cpio-trailer-name.pkg",
    );
    try {
      expect(entries.map((entry) => entry.path)).toEqual(
        expect.arrayContaining(["Payload/preinstall", "Scripts/preinstall"]),
      );
      expect(reader.formatMetadata()?.refusals).toEqual([
        expect.objectContaining({
          path: "Scripts",
          code: "cpio-malformed",
          message: expect.stringContaining(
            "trailer name is not exactly NUL-terminated",
          ),
        }),
      ]);
      expect(coverage).toEqual([
        expect.objectContaining({ status: "unknown" }),
      ]);
    } finally {
      await reader.close();
    }
  },
);

it("records a cpio name refusal even when it matches the remaining budget", async () => {
  const payload = buildCpioOdc([]);
  payload.write("000000", 59, "ascii");
  const { reader, coverage } = await entriesOf(
    buildXar({
      files: [
        { path: "PackageInfo", bytes: Buffer.from("<pkg-info/>") },
        { path: "Payload", bytes: payload },
      ],
    }),
    "zero-namesize.pkg",
    4096,
  );
  try {
    expect(reader.formatMetadata()?.refusals).toEqual([
      expect.objectContaining({
        code: "oversize",
        message: expect.stringContaining("namesize 0"),
      }),
    ]);
    expect(coverage).toEqual([
      expect.objectContaining({
        status: "unknown",
        limitations: expect.not.arrayContaining([
          expect.stringContaining("Did not expand Scripts/Payload"),
        ]),
      }),
    ]);
  } finally {
    await reader.close();
  }
});

it("refuses an oversize TOC file count as a capacity limit", async () => {
  const path = await writePkg("oversize.pkg", buildOversizeTocPackage());
  const reader = new MacosPkgArtifactReader(path);
  try {
    await expect(async () => {
      for await (const _entry of reader.entries()) {
        /* Exhaust the iterator. */
      }
    }).rejects.toMatchObject({ reason: "limit", boundary: "capacity" });
  } finally {
    await reader.close();
  }
});

it("refuses an oversize declared gzip member without inflating it", async () => {
  vi.mocked(inflateXarMemberBytes).mockClear();
  const { reader, entries } = await entriesOf(
    buildOversizeDeclaredGzipPackage(),
    "oversize-gzip.pkg",
  );
  try {
    expect(reader.formatMetadata()?.packages).toEqual([]);
    expect(reader.formatMetadata()?.refusals).toEqual([
      expect.objectContaining({
        code: "oversize",
        path: "PackageInfo",
      }),
    ]);
    expect(entries.map((entry) => entry.path)).toContain("PackageInfo");
    expect(inflateXarMemberBytes).not.toHaveBeenCalled();
  } finally {
    await reader.close();
  }
});

it("refuses an oversize archived gzip range without reading or inflating it", async () => {
  vi.mocked(inflateXarMemberBytes).mockClear();
  const { reader } = await entriesOf(
    buildOversizeArchivedGzipPackage(),
    "oversize-archived-gzip.pkg",
  );
  try {
    expect(reader.formatMetadata()?.packages).toEqual([]);
    expect(reader.formatMetadata()?.refusals).toEqual([
      expect.objectContaining({ code: "oversize", path: "PackageInfo" }),
    ]);
    expect(inflateXarMemberBytes).not.toHaveBeenCalled();
  } finally {
    await reader.close();
  }
});

it("refuses an unsupported member encoding without reading its archived range", async () => {
  vi.mocked(inflateXarMemberBytes).mockClear();
  const { reader } = await entriesOf(
    buildOversizeArchivedUnsupportedPackage(),
    "oversize-archived-bzip2.pkg",
  );
  try {
    expect(reader.formatMetadata()?.packages).toEqual([]);
    expect(reader.formatMetadata()?.refusals).toEqual([
      expect.objectContaining({ path: "PackageInfo" }),
    ]);
    expect(inflateXarMemberBytes).toHaveBeenCalledWith(
      Buffer.alloc(0),
      "application/x-bzip2",
      expect.any(Number),
      "PackageInfo",
    );
  } finally {
    await reader.close();
  }
});

it("refuses a gzip member whose decoded size disagrees with the TOC", async () => {
  const { reader, entries } = await entriesOf(
    buildExtractedSizeMismatchGzipPackage(),
    "size-mismatch.pkg",
  );
  try {
    expect(reader.formatMetadata()?.packages).toEqual([]);
    expect(reader.formatMetadata()?.refusals).toEqual([
      expect.objectContaining({
        code: "extracted-size-mismatch",
        path: "PackageInfo",
      }),
    ]);
    expect(entries.map((entry) => entry.path)).toContain("PackageInfo");
    await expect(
      reader.open(entries.find((entry) => entry.path === "PackageInfo")!),
    ).rejects.toMatchObject({ reason: "unavailable" });
  } finally {
    await reader.close();
  }
});

it("keeps a size-mismatched member unavailable through shared inspection", async () => {
  const path = await writePkg(
    "size-mismatch-inventory.pkg",
    buildExtractedSizeMismatchGzipPackage(),
  );
  const inventory = await scanCanonicalArtifactInventory(path);
  expect(inventory.coverage.status).toBe("unknown");
  expect(
    inventory.occurrences.find((row) => row.logical_path === ".")
      ?.format_metadata,
  ).toMatchObject({
    kind: "macos-pkg",
    refusals: [expect.objectContaining({ code: "extracted-size-mismatch" })],
  });
  expect(
    inventory.occurrences.find((row) => row.logical_path === "PackageInfo"),
  ).toMatchObject({ hash_status: "unavailable" });
});

it("stops a streamed XAR inflate before it emits past its allowance", async () => {
  const inflate = createBoundedXarInflate(16, "PackageInfo");
  let received = 0;
  inflate.on("data", (chunk: Buffer) => {
    received += chunk.length;
  });
  const done = new Promise<void>((resolve, reject) => {
    inflate.on("end", resolve);
    inflate.on("error", reject);
  });
  Readable.from([deflateSync(Buffer.alloc(1024 * 1024))]).pipe(inflate);
  await expect(done).rejects.toMatchObject({ reason: "limit" });
  expect(received).toBeLessThanOrEqual(16);
});

it("refuses open() of an oversize gzip member without inflating", async () => {
  vi.mocked(createBoundedXarInflate).mockClear();
  const path = await writePkg("open-oversize.pkg", buildGzipPackageInfo());
  const reader = new MacosPkgArtifactReader(path, undefined, 16);
  try {
    const listed = await collectEntries(reader);
    const pkgInfo = listed.find((entry) => entry.path === "PackageInfo");
    expect(pkgInfo).toBeDefined();
    await expect(reader.open(pkgInfo!)).rejects.toBeInstanceOf(
      ArtifactEntryContentUnavailable,
    );
    expect(createBoundedXarInflate).not.toHaveBeenCalled();
  } finally {
    await reader.close();
  }
});

it("expands Scripts and Payload for every product-archive component", async () => {
  const { reader, entries, coverage } = await entriesOf(
    buildMultiComponentProductArchive(),
    "multi.pkg",
  );
  try {
    expect(reader.formatMetadata()).toMatchObject({
      archive_kind: "product",
      distribution: { title: "REA Multi" },
      packages: [
        expect.objectContaining({ identifier: "com.rea.fixture.a" }),
        expect.objectContaining({ identifier: "com.rea.fixture.b" }),
      ],
      scripts: { present: true, preinstall: true, postinstall: true },
      payload: { present: true, compression: "gzip-cpio-odc" },
    });
    expect(coverage).toEqual([expect.objectContaining({ status: "complete" })]);
    const paths = entries.map((entry) => entry.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "A.pkg/Scripts/preinstall",
        "A.pkg/Payload/usr/local/rea/hello.txt",
        "B.pkg/Scripts/preinstall",
        "B.pkg/Payload/usr/local/rea/hello.txt",
      ]),
    );
    const helloA = entries.find(
      (entry) => entry.path === "A.pkg/Payload/usr/local/rea/hello.txt",
    );
    const helloB = entries.find(
      (entry) => entry.path === "B.pkg/Payload/usr/local/rea/hello.txt",
    );
    expect((await buffer(await reader.open(helloA!))).toString("utf8")).toBe(
      "hello from A\n",
    );
    expect((await buffer(await reader.open(helloB!))).toString("utf8")).toBe(
      "hello from B\n",
    );
  } finally {
    await reader.close();
  }
});

it("names skipped component archives when the expansion budget is exhausted", async () => {
  const { reader, entries, coverage } = await entriesOf(
    buildMultiComponentProductArchive(),
    "multi-budget.pkg",
    1,
  );
  try {
    expect(coverage).toEqual([
      expect.objectContaining({
        status: "unknown",
        limitations: expect.arrayContaining([
          expect.stringContaining("Did not expand Scripts/Payload for"),
        ]),
      }),
    ]);
    expect(coverage[0]).toMatchObject({
      limitations: expect.arrayContaining([
        expect.stringMatching(/A\.pkg\/Scripts.*B\.pkg\/Payload/s),
      ]),
    });
    const paths = entries.map((entry) => entry.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "A.pkg/Scripts",
        "A.pkg/Payload",
        "B.pkg/Scripts",
        "B.pkg/Payload",
      ]),
    );
    expect(paths).not.toContain("A.pkg/Payload/usr/local/rea/hello.txt");
    expect(paths).not.toContain("B.pkg/Payload/usr/local/rea/hello.txt");
    expect(reader.formatMetadata()?.scripts).toMatchObject({
      present: true,
      compression: "unread",
      members: [],
    });
    expect(reader.formatMetadata()?.payload).toMatchObject({
      present: true,
      compression: "unread",
      members: [],
    });
  } finally {
    await reader.close();
  }
});

it("admits zlib XAR members in TOC order within one expansion allowance", async () => {
  const mib = 1024 * 1024;
  const bytes = Buffer.alloc(2 * mib, 0x61);
  const { reader, entries, coverage } = await entriesOf(
    buildXar({
      files: [
        { path: "first.bin", encoding: "application/x-gzip", bytes },
        { path: "second.bin", encoding: "application/x-gzip", bytes },
      ],
    }),
    "zlib-resources.pkg",
    3 * mib,
  );
  try {
    const first = entries.find((entry) => entry.path === "first.bin")!;
    const second = entries.find((entry) => entry.path === "second.bin")!;
    expect((await buffer(await reader.open(first))).equals(bytes)).toBe(true);
    await expect(reader.open(second)).rejects.toBeInstanceOf(
      ArtifactEntryContentUnavailable,
    );
    expect(coverage).toEqual([
      expect.objectContaining({
        status: "unknown",
        limitations: [
          expect.stringMatching(
            /second\.bin.*artifact_limits\.expanded_bytes/u,
          ),
        ],
      }),
    ]);
  } finally {
    await reader.close();
  }
});

it("charges decoded payload bytes against the shared expansion budget", async () => {
  const decoded = 256 * 1024;
  const { reader, entries, coverage } = await entriesOf(
    buildExpandingPayloadsProductArchive(decoded),
    "expanding-payloads.pkg",
    decoded + decoded / 2,
  );
  try {
    const paths = entries.map((entry) => entry.path);
    expect(paths).toContain("A.pkg/Payload/big.bin");
    expect(paths).not.toContain("B.pkg/Payload/big.bin");
    expect(paths).toContain("B.pkg/Payload");
    expect(coverage).toEqual([
      expect.objectContaining({
        status: "unknown",
        limitations: [
          expect.stringMatching(
            /Did not expand Scripts\/Payload for B\.pkg\/Payload/u,
          ),
        ],
      }),
    ]);
  } finally {
    await reader.close();
  }
});

it("classifies a product archive as pkg and inventories it through the shared scan", async () => {
  const bytes = buildProductArchive();
  const path = await writePkg("scan.pkg", bytes);
  const inventory = await scanCanonicalArtifactInventory(path);
  expect(inventory.manifest.root_format).toBe("pkg");
  expect(inventory.coverage.status).toBe("complete");
  expect(
    inventory.occurrences.find((row) => row.logical_path === ".")
      ?.format_metadata,
  ).toMatchObject({ kind: "macos-pkg", archive_kind: "product" });
  expect(
    inventory.occurrences.some(
      (row) =>
        row.logical_path === "Component.pkg/Payload/usr/local/rea/hello.txt",
    ),
  ).toBe(true);
});

it("keeps FIFO and device payload members as non-materializable declarations", async () => {
  const { reader, entries } = await entriesOf(
    buildSpecialMemberPayloadPackage(),
  );
  try {
    const pipe = entries.find((entry) => entry.path === "Payload/pipe");
    const device = entries.find((entry) => entry.path === "Payload/null");
    expect(pipe).toMatchObject({
      kind: "metadata",
      executable: false,
      limitations: [expect.stringContaining("FIFO")],
      formatMetadata: expect.objectContaining({ mode: 0o010644 }),
    });
    expect(device).toMatchObject({
      kind: "metadata",
      limitations: [expect.stringContaining("character device")],
    });
    expect(
      entries.find((entry) => entry.path === "Payload/plain"),
    ).toMatchObject({ kind: "file" });
    expect(reader.formatMetadata()?.payload.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "pipe", kind: "other" }),
      ]),
    );
    await expect(reader.open(pipe!)).rejects.toMatchObject({
      reason: "unavailable",
    });
  } finally {
    await reader.close();
  }
});

it("keeps every TOC record that shares a path as its own occurrence", async () => {
  const { reader, entries, path } = await entriesOf(
    buildDuplicatePathPackage(),
  );
  try {
    const duplicates = entries.filter((entry) => entry.path === "dup.txt");
    expect(duplicates).toHaveLength(2);
    const contents = await Promise.all(
      duplicates.map(async (entry) =>
        (await buffer(await reader.open(entry))).toString("utf8"),
      ),
    );
    expect(contents.sort()).toEqual(["first\n", "second\n"]);
  } finally {
    await reader.close();
  }
  const inventory = await scanCanonicalArtifactInventory(path);
  expect(
    inventory.occurrences.filter((row) => row.logical_path === "dup.txt"),
  ).toHaveLength(2);
});

it("reads XAR TOC execute bits from owner, group and other permissions", async () => {
  const modes = {
    "owner-group.sh": "0750",
    "owner.sh": "0700",
    "group.sh": "0610",
    "other.sh": "0601",
    "plain.txt": "0644",
    "malformed.txt": "rwxr-x---",
  };
  const { reader, entries } = await entriesOf(
    buildXar({
      files: Object.entries(modes).map(([path, mode]) => ({
        path,
        mode,
        bytes: Buffer.from(path),
      })),
    }),
  );
  try {
    const executable = Object.fromEntries(
      entries.map((entry) => [entry.path, entry.executable]),
    );
    expect(executable).toEqual({
      "owner-group.sh": true,
      "owner.sh": true,
      "group.sh": true,
      "other.sh": true,
      "plain.txt": false,
      "malformed.txt": false,
    });
  } finally {
    await reader.close();
  }
});

it("keeps an out-of-range XAR TOC mode unknown instead of failing inventory", async () => {
  const { reader, entries, path } = await entriesOf(
    buildXar({
      files: [
        { path: "huge.sh", mode: "40000000000", bytes: Buffer.from("x") },
        { path: "max.sh", mode: "37777777777", bytes: Buffer.from("y") },
      ],
    }),
  );
  try {
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    expect(byPath.get("huge.sh")).toMatchObject({
      executable: false,
      formatMetadata: expect.objectContaining({ mode: null }),
    });
    expect(byPath.get("max.sh")).toMatchObject({
      executable: true,
      formatMetadata: expect.objectContaining({ mode: 0xffffffff }),
    });
  } finally {
    await reader.close();
  }
  const inventory = await scanCanonicalArtifactInventory(path);
  expect(inventory.occurrences.map((row) => row.logical_path).sort()).toEqual(
    expect.arrayContaining(["huge.sh", "max.sh"]),
  );
});

it("keeps directory and link-only symlink TOC records without heap bodies", async () => {
  const { reader, entries } = await entriesOf(
    buildXar({
      files: [
        { path: "Resources", type: "directory" },
        { path: "Resources/readme.txt", bytes: Buffer.from("readme\n") },
        { path: "Resources/current", type: "symlink", link: "readme.txt" },
        { path: "Resources/empty.txt" },
      ],
    }),
  );
  try {
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    expect(byPath.get("Resources")).toMatchObject({
      kind: "directory",
      byteOffset: null,
    });
    const link = byPath.get("Resources/current");
    expect(link).toMatchObject({
      kind: "symlink",
      declaredSize: "readme.txt".length,
      formatMetadata: expect.objectContaining({
        role: "xar-file",
        symlink_target: "readme.txt",
      }),
    });
    expect((await buffer(await reader.open(link!))).toString("utf8")).toBe(
      "readme.txt",
    );
    const empty = byPath.get("Resources/empty.txt");
    expect(empty).toMatchObject({ kind: "file", declaredSize: 0 });
    expect((await buffer(await reader.open(empty!))).length).toBe(0);
    await expect(reader.open(byPath.get("Resources")!)).rejects.toMatchObject({
      reason: "unavailable",
    });
  } finally {
    await reader.close();
  }
});

it("cancels a paused memory-backed payload member before it is read", async () => {
  const decoded = 1024 * 1024;
  const { reader, entries } = await entriesOf(
    buildExpandingPayloadsProductArchive(decoded),
    "paused-payload.pkg",
    decoded * 4,
  );
  try {
    const big = entries.find((entry) => entry.path === "A.pkg/Payload/big.bin");
    expect(big).toBeDefined();
    const controller = new AbortController();
    const stream = await reader.open(big!, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stream.readableLength).toBeGreaterThan(0);
    const closed = new Promise<unknown>((resolve) => {
      stream.once("close", () => resolve(stream.errored));
    });
    controller.abort(new Error("caller stopped"));
    await expect(closed).resolves.toMatchObject({ reason: "cancelled" });
    expect(stream.destroyed).toBe(true);
  } finally {
    await reader.close();
  }
});

it("cancels a paused zlib member after its archived range is read", async () => {
  const decoded = Buffer.alloc(8 * 1024 * 1024, 0x61);
  const { reader, entries } = await entriesOf(
    buildXar({
      files: [
        { path: "paused.bin", encoding: "application/x-gzip", bytes: decoded },
      ],
    }),
    "paused-zlib.pkg",
    decoded.length * 2,
  );
  try {
    const member = entries.find((entry) => entry.path === "paused.bin");
    expect(member).toBeDefined();
    const controller = new AbortController();
    const stream = await reader.open(member!, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stream.readableLength).toBeGreaterThan(0);
    const closed = new Promise<unknown>((resolve) => {
      stream.once("close", () => resolve(stream.errored));
    });
    controller.abort(new Error("caller stopped"));
    await expect(closed).resolves.toMatchObject({ reason: "cancelled" });
    expect(stream.destroyed).toBe(true);
  } finally {
    await reader.close();
  }
});

it("keeps a refusal from a cancelled preparation when another caller retries", async () => {
  const info = (id: string) =>
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>\n<pkg-info identifier="${id}" version="1.0.0" install-location="/" auth="root"/>\n`,
    );
  const path = await writePkg(
    "retry-refusal.pkg",
    buildXar({
      files: [
        { path: "A.pkg", type: "directory" },
        {
          path: "A.pkg/PackageInfo",
          bytes: info("com.rea.fixture.a"),
          encoding: "application/x-gzip",
          extractedSize: 1,
        },
        { path: "B.pkg", type: "directory" },
        { path: "B.pkg/PackageInfo", bytes: info("com.rea.fixture.b") },
      ],
    }),
  );
  const reader = new MacosPkgArtifactReader(path);
  const controller = new AbortController();
  const actual = vi.mocked(inflateXarMemberBytes).getMockImplementation()!;
  vi.mocked(inflateXarMemberBytes).mockImplementationOnce((...args) => {
    const result = actual(...args);
    controller.abort();
    return result;
  });
  try {
    const drain = async (signal?: AbortSignal) => {
      const coverage: { status: string }[] = [];
      const listed = [];
      for await (const entry of reader.entries(signal, {
        onCoverage: (value) => coverage.push(value),
      }))
        listed.push(entry);
      return { coverage, listed };
    };
    const cancelled = drain(controller.signal);
    const retried = drain();
    await expect(cancelled).rejects.toMatchObject({ reason: "cancelled" });
    const { coverage, listed } = await retried;
    expect(reader.formatMetadata()?.refusals).toEqual([
      expect.objectContaining({
        code: "extracted-size-mismatch",
        path: "A.pkg/PackageInfo",
      }),
    ]);
    expect(coverage).toEqual([expect.objectContaining({ status: "unknown" })]);
    expect(
      listed.filter((entry) => entry.path === "A.pkg/PackageInfo"),
    ).toHaveLength(1);
    await expect(
      reader.open(listed.find((entry) => entry.path === "A.pkg/PackageInfo")!),
    ).rejects.toBeInstanceOf(ArtifactEntryContentUnavailable);
  } finally {
    await reader.close();
  }
});

it("reports an oversize zlib XAR member as a limit rather than invalid gzip", () => {
  const archived = deflateSync(Buffer.alloc(64 * 1024, 0x61));
  const result = inflateXarMemberBytes(
    archived,
    "application/x-gzip",
    1024,
    "PackageInfo",
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatchObject({
    kind: "limit",
    failure: {
      field: "gzip",
      limit: { name: "macos_pkg_extracted_size", maximum: 1024 },
    },
  });
});

it("records an oversize refusal when a zlib PackageInfo inflates past its metadata cap despite a small declared size", async () => {
  const overCap = Buffer.alloc(1024 * 1024 + 64, 0x20);
  const { reader, entries } = await entriesOf(
    buildXar({
      files: [
        {
          path: "PackageInfo",
          bytes: overCap,
          encoding: "application/x-gzip",
          extractedSize: 64,
        },
      ],
    }),
    "lying-declared-size.pkg",
  );
  try {
    expect(reader.formatMetadata()?.packages).toEqual([]);
    expect(reader.formatMetadata()?.refusals).toEqual([
      expect.objectContaining({
        code: "oversize",
        path: "PackageInfo",
      }),
    ]);
    expect(entries.map((entry) => entry.path)).toContain("PackageInfo");
  } finally {
    await reader.close();
  }
});

it("refuses a TOC whose repeated directory prefix exceeds the expanded path-byte allowance", async () => {
  const dir = "d".repeat(1024 * 1024);
  const path = await writePkg(
    "long-toc-paths.pkg",
    buildXar({
      files: [
        { path: dir, type: "directory" },
        ...Array.from({ length: 5 }, (_, index) => ({
          path: `${dir}/f${String(index)}`,
          bytes: Buffer.from("x"),
        })),
      ],
    }),
  );
  const reader = new MacosPkgArtifactReader(path);
  try {
    await expect(async () => {
      for await (const _entry of reader.entries()) {
        /* Exhaust the iterator. */
      }
    }).rejects.toMatchObject({
      reason: "limit",
      boundary: "capacity",
      parserLimit: {
        name: "macos_pkg_toc_path_bytes",
        maximum: MACOS_PKG_MAX_TOC_PATH_BYTES,
      },
    });
  } finally {
    await reader.close();
  }
});

it("keeps intact PackageInfo, payload and signature when an unrelated TOC file record is damaged", async () => {
  const base = buildSignedProductArchive();
  const parsed = parseXarHeader(base);
  if (!parsed.ok) throw parsed.error;
  const { headerSize, tocCompressedLength } = parsed.value;
  const tocXml = inflateSync(
    base.subarray(headerSize, headerSize + tocCompressedLength),
  )
    .toString("utf8")
    .replace(
      "</toc>",
      '<file id="999"><name>damaged.bin</name><type>file</type><data><offset>0</offset><length>4</length></data></file></toc>',
    );
  const uncompressedToc = Buffer.from(tocXml, "utf8");
  const compressedToc = deflateSync(uncompressedToc);
  const checksum = createHash("sha1").update(compressedToc).digest();
  const header = Buffer.from(base.subarray(0, headerSize));
  header.writeBigUInt64BE(BigInt(compressedToc.length), 8);
  header.writeBigUInt64BE(BigInt(uncompressedToc.length), 16);
  const heapRest = base.subarray(
    headerSize + tocCompressedLength + checksum.length,
  );
  const damaged = Buffer.concat([header, compressedToc, checksum, heapRest]);

  const { reader, entries, coverage } = await entriesOf(
    damaged,
    "damaged-toc-record.pkg",
  );
  try {
    const metadata = reader.formatMetadata();
    expect(metadata?.signature).toMatchObject({
      present: true,
      toc_signature: true,
      certificate_count: 1,
    });
    expect(metadata?.packages).toEqual([
      expect.objectContaining({ identifier: "com.rea.fixture.component" }),
    ]);
    expect(metadata?.payload).toMatchObject({
      present: true,
      compression: "gzip-cpio-odc",
    });
    expect(metadata?.refusals).toEqual([
      expect.objectContaining({
        code: "toc-xml",
        path: "damaged.bin",
        message: expect.stringContaining("<size>"),
      }),
    ]);
    expect(entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        "Distribution",
        "Component.pkg/PackageInfo",
        "Component.pkg/Payload/usr/local/rea/hello.txt",
      ]),
    );
    expect(entries.map((entry) => entry.path)).not.toContain("damaged.bin");
    expect(coverage).toEqual([
      expect.objectContaining({
        status: "unknown",
        limitations: expect.arrayContaining([
          expect.stringContaining("<size>"),
        ]),
      }),
    ]);
  } finally {
    await reader.close();
  }
});

it("populates linkTarget for XAR and cpio symlinks, keeps raw cpio target bytes, and compares symlinks", async () => {
  const rawNonUtf8 = Buffer.from([0x66, 0x6f, 0x6f, 0xff]);
  const buildSymlinkPkg = (xarTarget: string, cpioTarget: Buffer): Buffer =>
    buildXar({
      files: [
        { path: "PackageInfo", bytes: Buffer.from("<pkg-info/>") },
        { path: "xar-link", type: "symlink", link: xarTarget },
        {
          path: "Payload",
          bytes: gzipSync(
            buildCpioOdc([
              { name: ".", mode: 0o040755 },
              { name: "cpio-link", mode: 0o120777, data: cpioTarget },
            ]),
          ),
        },
      ],
    });

  const leftBytes = buildSymlinkPkg("target-a", rawNonUtf8);
  const rightBytes = buildSymlinkPkg("target-b", Buffer.from("target-c"));

  const { reader, entries } = await entriesOf(leftBytes, "symlinks-left.pkg");
  try {
    const xarLink = entries.find((entry) => entry.path === "xar-link");
    const cpioLink = entries.find(
      (entry) => entry.path === "Payload/cpio-link",
    );
    expect(xarLink).toMatchObject({
      kind: "symlink",
      linkTarget: {
        text: "target-a",
        hex: Buffer.from("target-a", "utf8").toString("hex"),
      },
      formatMetadata: expect.objectContaining({ symlink_target: "target-a" }),
    });
    expect(cpioLink).toMatchObject({
      kind: "symlink",
      declaredSize: rawNonUtf8.length,
      linkTarget: {
        text: null,
        hex: rawNonUtf8.toString("hex"),
      },
      formatMetadata: expect.objectContaining({ symlink_target: null }),
    });
    expect(
      (await buffer(await reader.open(cpioLink!))).equals(rawNonUtf8),
    ).toBe(true);
  } finally {
    await reader.close();
  }

  const evidenceFor = async (name: string, bytes: Buffer) => {
    const filePath = await writePkg(name, bytes);
    const inventory = await scanCanonicalArtifactInventory(filePath);
    return createEvidence(
      {
        path: name,
        sha256: inventory.manifest.root_sha256,
        format: "pkg",
      },
      ARTIFACT_COMPARISON_EXAMPLE.left.provider,
      {
        operation: "inventory_artifact",
        parameters: {},
        result: inventory,
        confidence: "observed",
        authority: "shipped-artifact",
      },
    );
  };
  const leftEv = await evidenceFor("compare-left.pkg", leftBytes);
  const leftEvAgain = await evidenceFor("compare-left-again.pkg", leftBytes);
  const rightEv = await evidenceFor("compare-right.pkg", rightBytes);

  const same = compareArtifacts(leftEv, leftEvAgain);
  expect(same.changes).toEqual([]);

  const diff = compareArtifacts(leftEv, rightEv);
  const changedByPath = new Map(
    diff.changes.map((change) => [change.logical_path, change]),
  );
  expect(changedByPath.get("xar-link")).toMatchObject({
    classification: "changed",
    dimensions: expect.arrayContaining(["content"]),
  });
  expect(changedByPath.get("Payload/cpio-link")).toMatchObject({
    classification: "changed",
    dimensions: expect.arrayContaining(["content"]),
  });
});

it("enforces a package-wide cpio member cap across multiple Payload archives", async () => {
  const emptyMembers = (prefix: string, count: number) =>
    gzipSync(
      buildCpioOdc(
        Array.from({ length: count }, (_, index) => ({
          name: `${prefix}${String(index)}`,
          mode: 0o100644,
        })),
      ),
    );
  const { reader, entries, coverage } = await entriesOf(
    buildXar({
      files: [
        { path: "A.pkg", type: "directory" },
        { path: "A.pkg/Payload", bytes: emptyMembers("a", 2500) },
        { path: "B.pkg", type: "directory" },
        { path: "B.pkg/Payload", bytes: emptyMembers("b", 2500) },
        { path: "C.pkg", type: "directory" },
        { path: "C.pkg/Payload", bytes: emptyMembers("c", 10) },
      ],
    }),
    "multi-archive-cpio-cap.pkg",
  );
  try {
    const expandedPayloadEntries = entries.filter(
      (entry) =>
        entry.formatMetadata?.kind === "macos-pkg-entry" &&
        entry.formatMetadata.role === "payload-member",
    );
    expect(expandedPayloadEntries).toHaveLength(MACOS_PKG_MAX_CPIO_MEMBERS);
    expect(reader.formatMetadata()?.payload.members).toHaveLength(
      MACOS_PKG_MAX_CPIO_MEMBERS,
    );
    expect(reader.formatMetadata()?.refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "oversize", path: "B.pkg/Payload" }),
        expect.objectContaining({ code: "oversize", path: "C.pkg/Payload" }),
      ]),
    );
    const paths = entries.map((entry) => entry.path);
    expect(paths).toContain("C.pkg/Payload");
    expect(paths.some((path) => path.startsWith("C.pkg/Payload/"))).toBe(false);
    expect(coverage).toEqual([expect.objectContaining({ status: "unknown" })]);
  } finally {
    await reader.close();
  }
});

it("refuses non-UTF-8 cpio member names strictly without lossy replacement collisions", async () => {
  const nameFf = Buffer.from([0x66, 0x6f, 0x6f, 0xff]);
  const nameFe = Buffer.from([0x66, 0x6f, 0x6f, 0xfe]);
  const rawCpio = buildCpioOdc([
    { name: "good.txt", mode: 0o100644, data: Buffer.from("ok\n") },
    { name: "", nameBytes: nameFf, mode: 0o100644, data: Buffer.from("1") },
    { name: "", nameBytes: nameFe, mode: 0o100644, data: Buffer.from("2") },
  ]);
  const direct = parseCpioOdc(rawCpio);
  expect(direct.ok).toBe(false);
  if (!direct.ok) {
    expect(direct.error).toMatchObject({
      kind: "malformed",
      failure: { field: "name" },
    });
  }

  const { reader, entries, coverage } = await entriesOf(
    buildXar({
      files: [
        { path: "PackageInfo", bytes: Buffer.from("<pkg-info/>") },
        { path: "Payload", bytes: gzipSync(rawCpio) },
      ],
    }),
    "non-utf8-cpio-name.pkg",
  );
  try {
    expect(entries.map((entry) => entry.path)).toContain("Payload/good.txt");
    expect(
      entries.some(
        (entry) =>
          entry.path.includes("\ufffd") ||
          (entry.sourcePath?.includes("\ufffd") ?? false),
      ),
    ).toBe(false);
    expect(
      reader
        .formatMetadata()
        ?.payload.members.some((member) => member.name.includes("\ufffd")),
    ).toBe(false);
    expect(reader.formatMetadata()?.refusals).toEqual([
      expect.objectContaining({
        code: "cpio-malformed",
        path: "Payload",
      }),
    ]);
    expect(coverage).toEqual([expect.objectContaining({ status: "unknown" })]);
  } finally {
    await reader.close();
  }
});

it("selects only the root Distribution document even when Resources/Distribution precedes it", async () => {
  const decoyDistribution = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n<installer-gui-script minSpecVersion="2"><title>Decoy Resource</title></installer-gui-script>\n`,
  );
  const realDistribution = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n<installer-gui-script minSpecVersion="2"><title>Real Product</title><choices-outline><line choice="main"/></choices-outline><choice id="main"/></installer-gui-script>\n`,
  );
  const { reader } = await entriesOf(
    buildXar({
      preserveOrder: true,
      files: [
        { path: "Resources", type: "directory" },
        { path: "Resources/Distribution", bytes: decoyDistribution },
        { path: "Distribution", bytes: realDistribution },
      ],
    }),
    "nested-distribution.pkg",
  );
  try {
    expect(reader.formatMetadata()).toMatchObject({
      archive_kind: "product",
      distribution: {
        title: "Real Product",
        choices: ["main"],
      },
    });
  } finally {
    await reader.close();
  }

  const nestedOnly = await entriesOf(
    buildXar({
      preserveOrder: true,
      files: [
        { path: "Resources", type: "directory" },
        { path: "Resources/Distribution", bytes: decoyDistribution },
        {
          path: "PackageInfo",
          bytes: Buffer.from(
            `<?xml version="1.0" encoding="UTF-8"?>\n<pkg-info identifier="com.rea.component" version="1.0.0"/>\n`,
          ),
        },
      ],
    }),
    "nested-only-distribution.pkg",
  );
  try {
    expect(nestedOnly.reader.formatMetadata()).toMatchObject({
      archive_kind: "component",
      distribution: null,
    });
  } finally {
    await nestedOnly.reader.close();
  }
});

it("refuses an ordinary stored XAR member whose TOC size disagrees with its archived length", async () => {
  const pkgBytes = buildXar({
    files: [
      { path: "Resources", type: "directory" },
      {
        path: "Resources/note.txt",
        bytes: Buffer.from("abcd"),
        encoding: "application/octet-stream",
        extractedSize: 1,
      },
    ],
  });
  const { reader, entries, coverage, path } = await entriesOf(
    pkgBytes,
    "stored-size-mismatch.pkg",
  );
  try {
    expect(reader.formatMetadata()?.refusals).toEqual([
      expect.objectContaining({
        code: "extracted-size-mismatch",
        path: "Resources/note.txt",
      }),
    ]);
    expect(coverage).toEqual([expect.objectContaining({ status: "unknown" })]);
    const note = entries.find((entry) => entry.path === "Resources/note.txt");
    expect(note).toBeDefined();
    await expect(reader.open(note!)).rejects.toBeInstanceOf(
      ArtifactEntryContentUnavailable,
    );
  } finally {
    await reader.close();
  }

  const inventory = await scanCanonicalArtifactInventory(path);
  expect(inventory.coverage.status).toBe("unknown");
  expect(
    inventory.occurrences.find((row) => row.logical_path === ".")
      ?.format_metadata,
  ).toMatchObject({
    kind: "macos-pkg",
    refusals: [
      expect.objectContaining({
        code: "extracted-size-mismatch",
        path: "Resources/note.txt",
      }),
    ],
  });
  expect(
    inventory.occurrences.find(
      (row) => row.logical_path === "Resources/note.txt",
    ),
  ).toMatchObject({ hash_status: "unavailable" });
});

const buildAliasedPackageInfos = (
  packageInfoBytes: Buffer,
  aliasCount: number,
): Buffer => {
  const checksumSize = 20;
  const offset = checksumSize;
  const sha1 = createHash("sha1").update(packageInfoBytes).digest("hex");
  const dataXml = `<data><offset>${String(offset)}</offset><size>${String(packageInfoBytes.length)}</size><length>${String(packageInfoBytes.length)}</length><encoding style="application/octet-stream"/><extracted-checksum style="sha1">${sha1}</extracted-checksum><archived-checksum style="sha1">${sha1}</archived-checksum></data>`;
  const filesXml = Array.from(
    { length: aliasCount },
    (_, index) =>
      `<file id="${String(index * 2 + 1)}"><name>P${String(index)}.pkg</name><type>directory</type><file id="${String(index * 2 + 2)}"><name>PackageInfo</name><type>file</type>${dataXml}</file></file>`,
  ).join("");
  const toc = `<?xml version="1.0" encoding="UTF-8"?><xar><toc><checksum style="sha1"><offset>0</offset><size>${String(checksumSize)}</size></checksum>${filesXml}</toc></xar>`;
  const uncompressedToc = Buffer.from(toc, "utf8");
  const compressedToc = deflateSync(uncompressedToc);
  const checksum = createHash("sha1").update(compressedToc).digest();
  const header = Buffer.alloc(28);
  header.writeUInt32BE(0x78_61_72_21, 0);
  header.writeUInt16BE(28, 4);
  header.writeUInt16BE(1, 6);
  header.writeBigUInt64BE(BigInt(compressedToc.length), 8);
  header.writeBigUInt64BE(BigInt(uncompressedToc.length), 16);
  header.writeUInt32BE(1, 24);
  return Buffer.concat([header, compressedToc, checksum, packageInfoBytes]);
};

it("bounds total installer metadata bytes when many PackageInfo TOC records alias one stored heap range", async () => {
  vi.mocked(inflateXarMemberBytes).mockClear();
  const body = `<pkg-info identifier="com.rea.aliased" version="1.0.0">${" ".repeat(512 * 1024 - 70)}</pkg-info>`;
  const docBytes = Buffer.from(body, "utf8");
  const aliasCount = 32;
  const { reader, coverage } = await entriesOf(
    buildAliasedPackageInfos(docBytes, aliasCount),
    "aliased-packageinfo-bytes.pkg",
  );
  try {
    const metadata = reader.formatMetadata();
    const expectedAdmitted = Math.floor(
      MACOS_PKG_MAX_TOTAL_METADATA_XML_BYTES / docBytes.length,
    );
    expect(metadata?.packages).toHaveLength(expectedAdmitted);
    expect(metadata?.packages[0]).toMatchObject({
      path: "P0.pkg/PackageInfo",
      identifier: "com.rea.aliased",
    });
    expect(metadata?.refusals).toHaveLength(aliasCount - expectedAdmitted);
    expect(
      metadata?.refusals.every((refusal) => refusal.code === "oversize"),
    ).toBe(true);
    expect(vi.mocked(inflateXarMemberBytes)).toHaveBeenCalledTimes(
      expectedAdmitted,
    );
    expect(coverage).toEqual([expect.objectContaining({ status: "unknown" })]);
  } finally {
    await reader.close();
  }
});

it("bounds total retained bundle records across aliased PackageInfo entries and stops excessive <bundle/> documents", async () => {
  vi.mocked(inflateXarMemberBytes).mockClear();
  const bundleHeavy = Buffer.from(
    `<pkg-info identifier="com.rea.bundles">${"<bundle/>".repeat(1500)}</pkg-info>`,
    "utf8",
  );
  const { reader, coverage } = await entriesOf(
    buildAliasedPackageInfos(bundleHeavy, 10),
    "aliased-packageinfo-bundles.pkg",
  );
  try {
    const metadata = reader.formatMetadata();
    const retainedRecords = (metadata?.packages ?? []).reduce(
      (total, pkg) => total + 1 + pkg.bundles.length,
      0,
    );
    expect(metadata?.packages).toHaveLength(2);
    expect(retainedRecords).toBeLessThanOrEqual(MACOS_PKG_MAX_METADATA_RECORDS);
    expect(metadata?.refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "oversize",
          path: "P2.pkg/PackageInfo",
        }),
      ]),
    );
    expect(coverage).toEqual([expect.objectContaining({ status: "unknown" })]);
  } finally {
    await reader.close();
  }

  vi.mocked(inflateXarMemberBytes).mockClear();
  const oneMibBundles = Buffer.from(
    `<pkg-info>${"<bundle/>".repeat(110_000)}</pkg-info>`,
    "utf8",
  );
  const dense = await entriesOf(
    buildAliasedPackageInfos(oneMibBundles, 1000),
    "aliased-1mib-bundles.pkg",
  );
  try {
    const metadata = dense.reader.formatMetadata();
    expect(metadata?.packages).toEqual([]);
    expect(
      metadata?.refusals.every((refusal) => refusal.code === "oversize"),
    ).toBe(true);
    expect(metadata?.refusals).toHaveLength(1000);
    // Only the 4 reads fitting the 4 MiB package-wide metadata byte cap are decoded.
    expect(vi.mocked(inflateXarMemberBytes)).toHaveBeenCalledTimes(
      Math.floor(MACOS_PKG_MAX_TOTAL_METADATA_XML_BYTES / oneMibBundles.length),
    );
    expect(dense.coverage).toEqual([
      expect.objectContaining({ status: "unknown" }),
    ]);
  } finally {
    await dense.reader.close();
  }
});

it("raises installer metadata byte, record, and XML-node allowances when artifact_limits.expanded_bytes is raised", async () => {
  const largeDoc = Buffer.from(
    `<pkg-info identifier="com.rea.large" version="1.0.0">${"<bundle/>".repeat(1500)}${" ".repeat(600 * 1024)}</pkg-info>`,
    "utf8",
  );
  const pkgBytes = buildAliasedPackageInfos(largeDoc, 8);

  // Under the default budget (4 MiB / 4,096 records), metadata stops early
  // and points callers to artifact_limits.expanded_bytes for recovery.
  const defaulted = await entriesOf(pkgBytes, "large-metadata-default.pkg");
  try {
    const metadata = defaulted.reader.formatMetadata();
    expect(metadata?.packages).toHaveLength(2);
    expect(metadata?.refusals.length).toBeGreaterThan(0);
    expect(
      metadata?.refusals.every(
        (refusal) =>
          refusal.code === "oversize" &&
          refusal.message.includes("artifact_limits.expanded_bytes"),
      ),
    ).toBe(true);
    expect(defaulted.coverage).toEqual([
      expect.objectContaining({ status: "unknown" }),
    ]);
  } finally {
    await defaulted.reader.close();
  }

  // Raising artifact_limits.expanded_bytes admits all 8 documents (> 4 MiB,
  // 12,008 retained records > 4,096 default).
  const raised = await entriesOf(
    pkgBytes,
    "large-metadata-raised.pkg",
    16 * 1024 * 1024,
  );
  try {
    const metadata = raised.reader.formatMetadata();
    expect(metadata?.packages).toHaveLength(8);
    expect(metadata?.refusals).toEqual([]);
    expect(raised.coverage).toEqual([
      expect.objectContaining({ status: "complete" }),
    ]);
  } finally {
    await raised.reader.close();
  }

  // A single > 1 MiB PackageInfo is refused by default and admitted when
  // artifact_limits.expanded_bytes is raised.
  const singleOver1Mib = Buffer.from(
    `<pkg-info identifier="com.rea.single-large" version="1.0.0">${" ".repeat(1200 * 1024)}</pkg-info>`,
    "utf8",
  );
  const singlePkg = buildXar({
    files: [{ path: "PackageInfo", bytes: singleOver1Mib }],
  });
  const singleDefault = await entriesOf(singlePkg, "single-1mib-default.pkg");
  try {
    expect(singleDefault.reader.formatMetadata()?.packages).toEqual([]);
    expect(singleDefault.reader.formatMetadata()?.refusals).toEqual([
      expect.objectContaining({
        code: "oversize",
        path: "PackageInfo",
        message: expect.stringContaining("artifact_limits.expanded_bytes"),
      }),
    ]);
  } finally {
    await singleDefault.reader.close();
  }
  const singleRaised = await entriesOf(
    singlePkg,
    "single-1mib-raised.pkg",
    2 * 1024 * 1024,
  );
  try {
    expect(singleRaised.reader.formatMetadata()?.packages).toEqual([
      expect.objectContaining({ identifier: "com.rea.single-large" }),
    ]);
    expect(singleRaised.reader.formatMetadata()?.refusals).toEqual([]);
    expect(singleRaised.coverage).toEqual([
      expect.objectContaining({ status: "complete" }),
    ]);
  } finally {
    await singleRaised.reader.close();
  }
});

it("charges stored PackageInfo reads against the shared artifact_limits.expanded_bytes budget before Payload expansion", async () => {
  const pkgInfo = Buffer.from(
    `<pkg-info identifier="com.rea.shared" version="1.0.0">${" ".repeat(64 * 1024)}</pkg-info>`,
    "utf8",
  );
  const payloadBytes = gzipSync(
    buildCpioOdc([
      { name: ".", mode: 0o040755 },
      { name: "big.bin", mode: 0o100644, data: Buffer.alloc(64 * 1024, 0x61) },
    ]),
  );
  const pkg = buildXar({
    files: [
      { path: "PackageInfo", bytes: pkgInfo },
      { path: "Payload", bytes: payloadBytes },
    ],
  });
  // Budget fits PackageInfo (~64 KiB) but not PackageInfo + decoded Payload (~128 KiB).
  const { reader, entries, coverage } = await entriesOf(
    pkg,
    "shared-metadata-payload-budget.pkg",
    96 * 1024,
  );
  try {
    expect(reader.formatMetadata()?.packages).toEqual([
      expect.objectContaining({ identifier: "com.rea.shared" }),
    ]);
    expect(entries.map((entry) => entry.path)).not.toContain("Payload/big.bin");
    expect(coverage).toEqual([
      expect.objectContaining({
        status: "unknown",
        limitations: expect.arrayContaining([
          expect.stringContaining("Did not expand Scripts/Payload for Payload"),
        ]),
      }),
    ]);
  } finally {
    await reader.close();
  }
});

it("strips repeated leading ./ prefixes from cpio member names while preserving sourcePath and archive-root entries", async () => {
  const payload = gzipSync(
    buildCpioOdc([
      { name: "./.", mode: 0o040755 },
      { name: "././", mode: 0o040755 },
      { name: "././usr/bin/tool", mode: 0o100755, data: Buffer.from("tool\n") },
    ]),
  );
  const pkgBytes = buildXar({
    files: [
      {
        path: "PackageInfo",
        bytes: Buffer.from(`<pkg-info identifier="com.rea.dots"/>`),
      },
      { path: "Payload", bytes: payload },
    ],
  });
  const { reader, entries, coverage, path } = await entriesOf(
    pkgBytes,
    "repeated-dot-slash-cpio.pkg",
  );
  try {
    const tool = entries.find((entry) => entry.path === "Payload/usr/bin/tool");
    expect(tool).toMatchObject({
      path: "Payload/usr/bin/tool",
      sourcePath: "././usr/bin/tool",
      kind: "file",
      executable: true,
    });
    expect(
      entries.some(
        (entry) =>
          entry.path === "Payload/." ||
          entry.path === "Payload/./" ||
          entry.path.includes("/./"),
      ),
    ).toBe(false);
    expect(coverage).toEqual([expect.objectContaining({ status: "complete" })]);
  } finally {
    await reader.close();
  }

  const inventory = await scanCanonicalArtifactInventory(path);
  expect(inventory.coverage.status).toBe("complete");
  expect(
    inventory.occurrences.find(
      (row) => row.logical_path === "Payload/usr/bin/tool",
    ),
  ).toMatchObject({
    logical_path: "Payload/usr/bin/tool",
    source_path: "././usr/bin/tool",
    hash_status: "verified",
  });
});

it("raises cpio member-count and decoded-archive-byte allowances when artifact_limits.expanded_bytes is raised", async () => {
  const emptyMembers = (prefix: string, count: number) =>
    gzipSync(
      buildCpioOdc(
        Array.from({ length: count }, (_, index) => ({
          name: `${prefix}${String(index)}`,
          mode: 0o100644,
        })),
      ),
    );
  const manyMembersPkg = buildXar({
    files: [
      { path: "A.pkg", type: "directory" },
      { path: "A.pkg/Payload", bytes: emptyMembers("a", 2500) },
      { path: "B.pkg", type: "directory" },
      { path: "B.pkg/Payload", bytes: emptyMembers("b", 2500) },
    ],
  });

  // Default stops at 4,096 members and points callers to artifact_limits.expanded_bytes.
  const defaultedMembers = await entriesOf(
    manyMembersPkg,
    "cpio-members-default.pkg",
  );
  try {
    expect(
      defaultedMembers.reader.formatMetadata()?.payload.members,
    ).toHaveLength(MACOS_PKG_MAX_CPIO_MEMBERS);
    expect(defaultedMembers.reader.formatMetadata()?.refusals).toEqual([
      expect.objectContaining({
        code: "oversize",
        path: "B.pkg/Payload",
        message: expect.stringContaining("artifact_limits.expanded_bytes"),
      }),
    ]);
  } finally {
    await defaultedMembers.reader.close();
  }

  // Raising artifact_limits.expanded_bytes to 96 MiB scales maxMembers to 6,144 and admits all 5,000 members.
  const raisedMembers = await entriesOf(
    manyMembersPkg,
    "cpio-members-raised.pkg",
    96 * 1024 * 1024,
  );
  try {
    expect(raisedMembers.reader.formatMetadata()?.payload.members).toHaveLength(
      5000,
    );
    expect(raisedMembers.reader.formatMetadata()?.refusals).toEqual([]);
    expect(raisedMembers.coverage).toEqual([
      expect.objectContaining({ status: "complete" }),
    ]);
  } finally {
    await raisedMembers.reader.close();
  }

  // A > 64 MiB gzip-decoded Payload is refused under the 64 MiB default and
  // admitted when artifact_limits.expanded_bytes is raised above its decoded size.
  const over64MibSize = 64 * 1024 * 1024 + 4096;
  const largePayloadGz = gzipSync(
    buildCpioOdc([
      { name: ".", mode: 0o040755 },
      { name: "big.bin", mode: 0o100644, data: Buffer.alloc(over64MibSize) },
    ]),
  );
  const largePayloadPkg = buildXar({
    files: [
      {
        path: "PackageInfo",
        bytes: Buffer.from(`<pkg-info identifier="com.rea.big"/>`),
      },
      { path: "Payload", bytes: largePayloadGz },
    ],
  });

  const raisedLarge = await entriesOf(
    largePayloadPkg,
    "cpio-over-64mib-raised.pkg",
    80 * 1024 * 1024,
  );
  try {
    const bigEntry = raisedLarge.entries.find(
      (entry) => entry.path === "Payload/big.bin",
    );
    expect(bigEntry).toMatchObject({
      path: "Payload/big.bin",
      declaredSize: over64MibSize,
    });
    expect(raisedLarge.reader.formatMetadata()?.refusals).toEqual([]);
    expect(raisedLarge.coverage).toEqual([
      expect.objectContaining({ status: "complete" }),
    ]);
  } finally {
    await raisedLarge.reader.close();
  }
});
