import { buffer } from "node:stream/consumers";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { deflateSync, gzipSync } from "node:zlib";

import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import { MacosPkgArtifactReader } from "./MacosPkgArtifactReader.js";
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
} from "./macosPkg/MacosPkg.fixture.js";
import { parseCpioOdc } from "./macosPkg/CpioOdc.js";
import { buildCpioOdc, buildXar } from "./macosPkg/MacosPkg.fixture.js";

const writePkg = async (name: string, bytes: Buffer): Promise<string> => {
  const directory = await createTestTempDirectory("rea-macos-pkg-");
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
};

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

it("fails open() of an oversize gzip member with a limit error without inflating", async () => {
  vi.mocked(createBoundedXarInflate).mockClear();
  const path = await writePkg("open-oversize.pkg", buildGzipPackageInfo());
  const reader = new MacosPkgArtifactReader(path, undefined, 16);
  try {
    const listed = [];
    for await (const entry of reader.entries()) listed.push(entry);
    const pkgInfo = listed.find((entry) => entry.path === "PackageInfo");
    expect(pkgInfo).toBeDefined();
    await expect(reader.open(pkgInfo!)).rejects.toMatchObject({
      reason: "limit",
    });
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
        limitations: [
          expect.stringContaining("Did not expand Scripts/Payload for"),
        ],
      }),
    ]);
    expect(coverage[0]).toMatchObject({
      limitations: [expect.stringMatching(/A\.pkg\/Scripts.*B\.pkg\/Payload/s)],
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
