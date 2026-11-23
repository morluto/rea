import { afterEach, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";

import { inspectDebPackageInputSchema } from "../domain/deb/debPackage.js";
import { projectDebPackageView } from "../domain/analysisView/debPackageView.js";
import {
  DebPackageAllowanceFailure,
  DebPackageCapacityFailure,
  DebPackageFormatFailure,
} from "./DebPackage.errors.js";
import {
  DEFAULT_CONTROL_TEXT,
  debPackageFixture,
  notArBytes,
  tarArchive,
  tarMember,
  truncatedAfterDebianBinaryBytes,
  truncatedArMemberBytes,
  xzStub,
} from "./DebPackage.fixture.js";
import {
  DEB_PACKAGE_LIMITATIONS,
  parseDebPackage,
  parsePax,
  undecodableTarNamesLimitation,
  unreadableRelationshipsDetail,
} from "./DebPackageParser.js";
import { replaceXzBindingForTests } from "./xzDecoder.js";
import { zstandardWindowFrameFixture } from "../../tests/fixtures/zipZstandard.js";

const artifact = (bytes: Uint8Array) => ({
  path: "/artifacts/hello.deb",
  sha256: "a".repeat(64),
  bytes: bytes.length,
});

const parse = (bytes: Uint8Array, overrides: Record<string, number> = {}) =>
  parseDebPackage(
    bytes,
    artifact(bytes),
    inspectDebPackageInputSchema.parse({
      path: "/artifacts/hello.deb",
      ...overrides,
    }),
  );

afterEach(() => {
  replaceXzBindingForTests(undefined);
});

const paragraphReads = vi.hoisted(() => ({ largest: 0 }));

vi.mock("../domain/desktop/aptRepositories.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../domain/desktop/aptRepositories.js")
    >();
  return {
    ...actual,
    deb822Paragraphs: (
      ...args: Parameters<typeof actual.deb822Paragraphs>
    ): ReturnType<typeof actual.deb822Paragraphs> => {
      const found = actual.deb822Paragraphs(...args);
      paragraphReads.largest = Math.max(paragraphReads.largest, found.length);
      return found;
    },
  };
});

const expectFailure = <Failure>(
  run: () => unknown,
  ErrorType: new (...args: never[]) => Failure,
): Failure => {
  try {
    run();
  } catch (cause: unknown) {
    expect(cause).toBeInstanceOf(ErrorType);
    return cause as Failure;
  }
  throw new Error("Expected Debian package parse failure");
};

it("reads identity, relationships, scripts, inventory, and md5sums cross-check", () => {
  const report = parse(debPackageFixture());
  expect(report.ar.magic).toBe("!<arch>\n");
  expect(report.ar.format_version).toBe("2.0");
  expect(report.ar.members.map((member) => member.name)).toEqual([
    "debian-binary",
    "control.tar.gz",
    "data.tar.gz",
  ]);
  expect(report.control).toMatchObject({
    package: "hello",
    version: { raw: "1:2.03-1", epoch: 1, upstream: "2.03", revision: "1" },
    architecture: "all",
    maintainer: "Alice <alice@example.com>",
    installed_size: 12,
    homepage: "https://example.invalid/hello",
    description_summary: "greeting tool",
    essential: false,
    conffiles: { present: true, count: 1 },
    md5sums: { present: true, count: 1 },
  });
  expect(report.control?.relationships.depends).toEqual([
    [
      {
        name: "libc6",
        arch_qualifier: null,
        operator: ">=",
        version: "2.34",
        arch_restriction: null,
      },
    ],
    [
      {
        name: "python3",
        arch_qualifier: "any",
        operator: null,
        version: null,
        arch_restriction: null,
      },
      {
        name: "python3-minimal",
        arch_qualifier: null,
        operator: ">=",
        version: "3.11",
        arch_restriction: null,
      },
    ],
    [
      {
        name: "foo",
        arch_qualifier: null,
        operator: null,
        version: null,
        arch_restriction: {
          negated: false,
          architectures: ["amd64", "i386"],
        },
      },
    ],
    [
      {
        name: "bar",
        arch_qualifier: null,
        operator: ">=",
        version: "1.0",
        arch_restriction: { negated: true, architectures: ["armel"] },
      },
    ],
  ]);
  expect(report.control?.maintainer_scripts).toEqual(
    ["preinst", "postinst", "prerm", "postrm", "config", "triggers"].map(
      (name) => ({
        name,
        interpreter: "/bin/sh",
        bytes: 17,
      }),
    ),
  );
  expect(report.data_entries.map((entry) => [entry.path, entry.type])).toEqual([
    [".", "directory"],
    ["usr", "directory"],
    ["usr/bin", "directory"],
    ["usr/bin/hello", "file"],
    ["usr/bin/hi", "symlink"],
    ["etc", "directory"],
    ["etc/hello.conf", "file"],
  ]);
  expect(
    report.data_entries.find((entry) => entry.path === "usr/bin/hi"),
  ).toMatchObject({
    link_target: "hello",
  });
  expect(report.md5sums_cross_check).toEqual({
    listed: 1,
    present: 1,
    missing_from_inventory: 0,
    missing_from_md5sums: 1,
  });
  expect(report.coverage.status).toBe("complete");
  expect(report.limitations).toEqual([
    DEB_PACKAGE_LIMITATIONS.readOnly,
    DEB_PACKAGE_LIMITATIONS.noSignatures,
    DEB_PACKAGE_LIMITATIONS.noScriptText,
    DEB_PACKAGE_LIMITATIONS.md5NoHash,
  ]);
});

it.each(["gzip", "zstd", "xz", "none"] as const)(
  "decodes %s control and data members",
  (compression) => {
    const report = parse(
      debPackageFixture({
        controlCompression: compression,
        dataCompression: compression,
      }),
    );
    expect(report.control?.package).toBe("hello");
    expect(
      report.data_entries.some((entry) => entry.path === "usr/bin/hello"),
    ).toBe(true);
    expect(
      report.ar.members
        .filter((member) => member.role === "control" || member.role === "data")
        .map((member) => member.compression),
    ).toEqual([compression, compression]);
  },
);

it("decodes xz data after reading gzip control", () => {
  const report = parse(
    debPackageFixture({
      controlCompression: "gzip",
      dataCompression: "xz",
    }),
  );
  expect(report.control?.package).toBe("hello");
  expect(
    report.data_entries.some((entry) => entry.path === "usr/bin/hello"),
  ).toBe(true);
  expect(report.ar.members.map((member) => member.name)).toEqual([
    "debian-binary",
    "control.tar.gz",
    "data.tar.xz",
  ]);
});

it("refuses a truncated xz control member", () => {
  const error = expectFailure(
    () =>
      parse(
        debPackageFixture({
          controlCompression: "xz",
          controlMemberBytes: xzStub(),
        }),
      ),
    DebPackageFormatFailure,
  );
  expect(error.kind).toBe("truncated");
  expect(error.message).toMatch(/truncated xz/u);
  expect(error.partial?.ar.members.map((member) => member.name)).toEqual([
    "debian-binary",
    "control.tar.xz",
    "data.tar.gz",
  ]);
  expect(error.partial?.control).toBeNull();
});

it("refuses an xz control member that expands past max_control_bytes", () => {
  const error = expectFailure(
    () =>
      parse(debPackageFixture({ controlCompression: "xz" }), {
        max_control_bytes: 1024,
      }),
    DebPackageCapacityFailure,
  );
  expect(error.resource).toBe("max_control_bytes");
  expect(error.message).toMatch(/control\.tar\.xz/u);
  expect(error.partial?.ar.members.map((member) => member.name)).toContain(
    "control.tar.xz",
  );
});

it("refuses xz members when the native decoder cannot load", () => {
  const bytes = debPackageFixture({ controlCompression: "xz" });
  replaceXzBindingForTests({
    status: "unavailable",
    cause: Object.assign(new Error("dlopen failed"), {
      code: "ERR_DLOPEN_FAILED",
    }),
  });
  const error = expectFailure(() => parse(bytes), DebPackageFormatFailure);
  expect(error.kind).toBe("unsupported");
  expect(error.message).toMatch(/unavailable on this platform/u);
});

it("reports a Zstandard frame above the decoder window as an allowance, not damage", () => {
  // Window descriptor 0x90 declares 256 MiB; the single raw block is valid.
  const { compressed } = zstandardWindowFrameFixture(0x90);
  const error = expectFailure(
    () =>
      parse(
        debPackageFixture({
          controlCompression: "zstd",
          controlMemberBytes: compressed,
        }),
      ),
    DebPackageAllowanceFailure,
  );
  expect(error.failure).toMatchObject({
    kind: "limit",
    limit: { name: "zstd_window_bytes", maximum: 2 ** 27 },
  });
  expect(error.message).toContain("fixed 128 MiB allowance");
  expect(error.partial?.ar.members.map((member) => member.name)).toContain(
    "control.tar.zst",
  );
});

it("reads only the first control paragraph however many follow", () => {
  paragraphReads.largest = 0;
  const report = parse(
    debPackageFixture({
      controlText: `Package: hello\nVersion: 1.0\nArchitecture: all\n\n${"a:b\n\n".repeat(100_000)}`,
    }),
  );
  expect(report.control).toMatchObject({
    package: "hello",
    version: { raw: "1.0" },
  });
  expect(paragraphReads.largest).toBe(1);
});

it("reports an unreadable tar mode as null with a malformed issue", () => {
  const report = parse(
    debPackageFixture({
      dataEntries: [
        { name: "./", type: "5", mode: 0o755, content: "" },
        { name: "./usr/bin/hello", content: "", modeField: "07x5\0" },
      ],
    }),
  );
  const entry = report.data_entries.find(({ path }) =>
    path.endsWith("usr/bin/hello"),
  );
  expect(entry?.mode).toBeNull();
  expect(report.issues).toContainEqual(
    expect.objectContaining({ kind: "malformed", field: "mode" }),
  );
  expect(report.coverage.status).toBe("partial");
});

it("keeps missing optional control fields null rather than empty", () => {
  const report = parse(
    debPackageFixture({
      controlText: "Package: hello\nVersion: 1.0\nArchitecture: all\n",
      conffiles: null,
      md5sums: null,
      scripts: false,
    }),
  );
  expect(report.control).toMatchObject({
    package: "hello",
    version: { raw: "1.0", epoch: null, upstream: "1.0", revision: null },
    homepage: null,
    description_summary: null,
    essential: null,
    source: null,
    multi_arch: null,
    conffiles: { present: false, count: null },
    md5sums: { present: false, count: null },
    maintainer_scripts: [],
    relationships: {
      depends: null,
      pre_depends: null,
      recommends: null,
    },
  });
  expect(report.md5sums_cross_check).toBeNull();
});

it("refuses bytes that are not an ar archive", () => {
  const error = expectFailure(
    () => parse(notArBytes()),
    DebPackageFormatFailure,
  );
  expect(error.kind).toBe("malformed");
  expect(error.message).toMatch(/ar magic/u);
  expect(error.partial).toBeUndefined();
});

it("keeps debian-binary when a later ar member is truncated", () => {
  const error = expectFailure(
    () => parse(truncatedAfterDebianBinaryBytes()),
    DebPackageFormatFailure,
  );
  expect(error.kind).toBe("truncated");
  expect(error.partial?.ar.format_version).toBe("2.0");
  expect(error.partial?.ar.members.map((member) => member.name)).toEqual([
    "debian-binary",
  ]);
});

it("refuses a truncated first member without inventing ar facts", () => {
  const error = expectFailure(
    () => parse(truncatedArMemberBytes()),
    DebPackageFormatFailure,
  );
  expect(error.kind).toBe("truncated");
  expect(error.partial?.ar.members).toEqual([]);
});

/** A fixture whose final data.tar.gz member has an odd stored size. */
const oddFinalMemberFixture = (bsdNames: boolean): Buffer => {
  for (let extra = 0; extra < 64; extra++) {
    const bytes = debPackageFixture({
      bsdNames,
      dataEntries: [
        { name: "./", type: "5", mode: 0o755, content: "" },
        { name: "./usr/share/hello.txt", content: "y".repeat(extra) },
      ],
    });
    const payload = parse(bytes).ar.members.at(-1)?.size ?? 0;
    const stored = payload + (bsdNames ? "data.tar.gz".length : 0);
    if (stored % 2 === 1) return bytes;
  }
  throw new Error("no odd-sized data.tar.gz fixture");
};

it.for([false, true])(
  "refuses an odd final ar member missing its padding byte (BSD names: %s)",
  (bsdNames) => {
    const bytes = oddFinalMemberFixture(bsdNames);
    expect(parse(bytes).coverage.status).toBe("complete");
    const error = expectFailure(
      () => parse(bytes.subarray(0, bytes.length - 1)),
      DebPackageFormatFailure,
    );
    expect(error.kind).toBe("truncated");
    expect(error.message).toMatch(/padding byte/u);
  },
);

it("aligns BSD extended-name members by their stored size", () => {
  // debian-binary (13 bytes) plus "2.0\n" stores 17 bytes, so the padding
  // byte follows the stored extent even though the payload is even.
  const report = parse(debPackageFixture({ bsdNames: true }));
  expect(report.ar.members.map((member) => member.name)).toEqual([
    "debian-binary",
    "control.tar.gz",
    "data.tar.gz",
  ]);
  expect(report.ar.format_version).toBe("2.0");
  expect(report.coverage.status).toBe("complete");
});

it("keeps parsed control when the data tar checksum fails", () => {
  const error = expectFailure(
    () => parse(debPackageFixture({ corruptDataChecksum: true })),
    DebPackageFormatFailure,
  );
  expect(error.kind).toBe("malformed");
  expect(error.message).toMatch(/checksum/u);
  expect(error.partial?.control?.package).toBe("hello");
  expect(error.partial?.data_entries).toEqual([]);
});

it("keeps inventoried data entries when the selected count is exceeded", () => {
  const error = expectFailure(
    () => parse(debPackageFixture(), { max_data_entries: 1 }),
    DebPackageCapacityFailure,
  );
  expect(error.resource).toBe("max_data_entries");
  expect(error.partial?.control?.package).toBe("hello");
  expect(error.partial?.data_entries).toHaveLength(1);
});

it("reports partial coverage when control.tar holds no control file", () => {
  const report = parse(debPackageFixture({ controlEntries: [] }));
  expect(report.coverage.status).toBe("partial");
  expect(report.limitations).toContain("control.tar held no control file.");
});

it("reports partial coverage when debian-binary is empty", () => {
  const report = parse(debPackageFixture({ debianBinary: "" }));
  expect(report.ar.format_version).toBeNull();
  expect(report.coverage.status).toBe("partial");
});

it("counts a hardlinked md5sums path as present in the inventory", () => {
  const sum = "d41d8cd98f00b204e9800998ecf8427e";
  const report = parse(
    debPackageFixture({
      md5sums: `${sum}  usr/bin/hello\n${sum}  usr/bin/hello-link\n`,
      dataEntries: [
        { name: "./", type: "5", mode: 0o755, content: "" },
        { name: "./usr/", type: "5", mode: 0o755, content: "" },
        { name: "./usr/bin/", type: "5", mode: 0o755, content: "" },
        { name: "./usr/bin/hello", content: "", mode: 0o755 },
        {
          name: "./usr/bin/hello-link",
          type: "1",
          mode: 0o755,
          linkname: "./usr/bin/hello",
        },
      ],
    }),
  );
  expect(report.md5sums_cross_check).toEqual({
    listed: 2,
    present: 2,
    missing_from_inventory: 0,
    missing_from_md5sums: 0,
  });
});

const paxRecord = (key: string, value: string | Uint8Array): Buffer => {
  const body = Buffer.concat([
    Buffer.from(` ${key}=`, "utf8"),
    typeof value === "string" ? Buffer.from(value, "utf8") : value,
    Buffer.from("\n", "utf8"),
  ]);
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length += 1;
  return Buffer.concat([Buffer.from(String(length), "utf8"), body]);
};

it("reads PAX records by byte length, so a UTF-8 path keeps the next field", () => {
  const report = parse(
    debPackageFixture({
      dataEntries: [
        { name: "./", type: "5", mode: 0o755, content: "" },
        {
          name: "./PaxHeaders/cafe",
          type: "x",
          content: Buffer.concat([
            paxRecord("path", "./usr/share/café"),
            paxRecord("linkpath", "target"),
          ]),
        },
        { name: "./usr/share/cafe", type: "2", linkname: "ignored" },
      ],
    }),
  );
  const entry = report.data_entries.find(
    (candidate) => candidate.path === "usr/share/café",
  );
  expect(entry?.link_target).toBe("target");
});

it("keeps only the PAX keys it applies, so distinct unknown keys cost no storage", () => {
  const unknown = Array.from({ length: 10_000 }, (_, index) =>
    paxRecord(`k${String(index)}`, ""),
  );
  const parsed = parsePax(
    Buffer.concat([
      ...unknown,
      paxRecord("path", "./usr/share/a"),
      paxRecord("mtime", "1"),
      paxRecord("uname", Buffer.from([0xff])),
    ]),
  );
  expect(parsed.incompleteAt).toBeUndefined();
  expect(Object.keys(parsed.fields).sort()).toEqual(["path", "uname"]);
  expect(parsed.fields.path).toBe("./usr/share/a");
  expect([...parsed.undecodable]).toEqual(["uname"]);
});

it("refuses a GNU PAX sparse entry instead of reporting its stored name and size", () => {
  const error = expectFailure(
    () =>
      parse(
        debPackageFixture({
          dataEntries: [
            { name: "./", type: "5", mode: 0o755, content: "" },
            {
              name: "./PaxHeaders/sparse",
              type: "x",
              content: Buffer.concat([
                paxRecord("GNU.sparse.major", "1"),
                paxRecord("GNU.sparse.minor", "0"),
                paxRecord("GNU.sparse.name", "./usr/lib/big"),
                paxRecord("GNU.sparse.realsize", "1048576"),
              ]),
            },
            { name: "./GNUSparseFile.0/big", content: "1\n0\n4\nabcd" },
          ],
        }),
      ),
    DebPackageFormatFailure,
  );
  expect(error.kind).toBe("unsupported");
  expect(error.message).toMatch(/GNU sparse entry/u);
});

it("refuses an old GNU sparse entry", () => {
  const error = expectFailure(
    () =>
      parse(
        debPackageFixture({
          dataEntries: [{ name: "./usr/lib/big", type: "S", content: "abcd" }],
        }),
      ),
    DebPackageFormatFailure,
  );
  expect(error.kind).toBe("unsupported");
  expect(error.message).toMatch(/GNU sparse entry/u);
});

it("reports a PAX path that is not UTF-8 as a limitation", () => {
  const report = parse(
    debPackageFixture({
      dataEntries: [
        { name: "./", type: "5", mode: 0o755, content: "" },
        {
          name: "./PaxHeaders/h",
          type: "x",
          content: paxRecord(
            "path",
            Buffer.concat([Buffer.from("./usr/bin/h"), Buffer.from([0xff])]),
          ),
        },
        { name: "./usr/bin/h", content: "" },
      ],
    }),
  );
  expect(report.limitations).toContain(undecodableTarNamesLimitation(1));
});

it("reads control files from the control.tar root, not nested paths", () => {
  const report = parse(
    debPackageFixture({
      controlEntries: [
        {
          name: "./subdir/control",
          content: "Package: nested\nVersion: 9.9\nArchitecture: all\n",
        },
        { name: "./subdir/postinst", content: "#!/bin/sh\nexit 0\n" },
        {
          name: "./control",
          content: "Package: hello\nVersion: 1.0\nArchitecture: all\n",
        },
      ],
    }),
  );
  expect(report.control?.package).toBe("hello");
  expect(report.control?.maintainer_scripts).toEqual([]);
});

it("keeps UTF-8, surrounding spaces, and backslashes in tar names", () => {
  const sum = "d41d8cd98f00b204e9800998ecf8427e";
  const names = [
    "usr/share/café",
    "usr/share/ padded ",
    "usr/share/back\\slash",
  ];
  const report = parse(
    debPackageFixture({
      md5sums: names.map((name) => `${sum}  ${name}\n`).join(""),
      dataEntries: [
        { name: "./", type: "5", mode: 0o755, content: "" },
        { name: "./usr/share/", type: "5", mode: 0o755, content: "" },
        ...names.map((name) => ({ name: `./${name}`, content: "" })),
        {
          name: "./usr/share/link",
          type: "2",
          linkname: "café ",
        },
      ],
    }),
  );
  const paths = report.data_entries.map((entry) => entry.path);
  for (const name of names) expect(paths).toContain(name);
  expect(
    report.data_entries.find((entry) => entry.path === "usr/share/link")
      ?.link_target,
  ).toBe("café ");
  expect(report.md5sums_cross_check).toEqual({
    listed: 3,
    present: 3,
    missing_from_inventory: 0,
    missing_from_md5sums: 0,
  });
  expect(report.limitations).not.toContain(undecodableTarNamesLimitation(1));
});

it("reports tar names that are not UTF-8 as a limitation", () => {
  const report = parse(
    debPackageFixture({
      dataEntries: [
        { name: "./", type: "5", mode: 0o755, content: "" },
        {
          name: "",
          nameBytes: Buffer.concat([
            Buffer.from("./usr/bin/h", "utf8"),
            Buffer.from([0xff]),
          ]),
          content: "",
        },
      ],
    }),
  );
  expect(report.data_entries.map((entry) => entry.path)).toContain(
    "usr/bin/h\uFFFD",
  );
  expect(report.limitations).toContain(undecodableTarNamesLimitation(1));
});

it("keeps the md5sums cross-check unknown when md5sums is not UTF-8", () => {
  const report = parse(
    debPackageFixture({
      controlEntries: [
        {
          name: "./control",
          content: "Package: hello\nVersion: 1.0\nArchitecture: all\n",
        },
        { name: "./md5sums", content: Buffer.from([0xff, 0xfe, 0x0a]) },
      ],
    }),
  );
  expect(report.control?.md5sums.present).toBe(true);
  expect(report.md5sums_cross_check).toBeNull();
  expect(report.limitations).toContain(
    "md5sums is not readable UTF-8 text; the md5sums cross-check is unknown.",
  );
});

it.each(["1:", "1:-1", "1.0-"])(
  "reports a field issue for the malformed Version %s",
  (version) => {
    const report = parse(
      debPackageFixture({
        controlText: `Package: hello\nVersion: ${version}\nArchitecture: all\n`,
      }),
    );
    expect(report.control?.version).toBeNull();
    expect(report.issues).toContainEqual(
      expect.objectContaining({ kind: "malformed", field: "Version" }),
    );
    expect(report.coverage.status).toBe("partial");
  },
);

it("reads an Installed-Size with a long NUL run and continuation in linear time", () => {
  // A NUL run followed by a continuation line makes a NUL-to-end regex retry
  // from every NUL; 128 KiB of this took over ten seconds before the fix.
  const value = `1${"\0".repeat(128 * 1024)}\n x`;
  const started = performance.now();
  const report = parse(
    debPackageFixture({
      controlText: `Package: hello\nVersion: 1.0\nArchitecture: all\nInstalled-Size: ${value}\n`,
    }),
  );
  expect(performance.now() - started).toBeLessThan(2000);
  expect(report.control?.installed_size ?? null).toBeNull();
  expect(report.issues).toContainEqual(
    expect.objectContaining({ kind: "malformed", field: "Installed-Size" }),
  );
});

it("reports a field issue for an Installed-Size past the safe integer range", () => {
  const report = parse(
    debPackageFixture({
      controlText: `Package: hello\nVersion: 1.0\nArchitecture: all\nInstalled-Size: ${"9".repeat(400)}\n`,
    }),
  );
  expect(report.control?.installed_size).toBeNull();
  expect(report.issues).toContainEqual(
    expect.objectContaining({ kind: "malformed", field: "Installed-Size" }),
  );
});

it("flags extra ar members without treating them as control or data", () => {
  const report = parse(
    debPackageFixture({
      extraMembers: [{ name: "_gpgorigin", data: Buffer.from("sig") }],
    }),
  );
  expect(report.ar.extra_member_names).toEqual(["_gpgorigin"]);
  expect(report.coverage.status).toBe("partial");
});

it("flags a repeated data member as extra and keeps coverage partial", () => {
  const report = parse(
    debPackageFixture({
      dataEntries: [],
      extraMembers: [
        {
          name: "data.tar.gz",
          data: gzipSync(
            tarArchive([{ name: "./usr/bin/hidden", content: "x" }]),
          ),
        },
      ],
    }),
  );
  expect(report.ar.extra_member_names).toEqual(["data.tar.gz"]);
  expect(report.data_entries).toEqual([]);
  expect(report.coverage.status).toBe("partial");
  expect(report.limitations).toContain(
    "ar member data.tar.gz repeats an earlier member's role and was not read.",
  );
});

it("summarizes retained Debian package facts without reopening the archive", () => {
  const report = parse(debPackageFixture());
  const projected = projectDebPackageView(
    {
      evidenceId: `ev_${"b".repeat(64)}`,
      operation: "inspect_deb_package",
      predicateType: "rea.deb-package",
      normalizedResult: report,
      limitations: report.limitations,
    },
    { kind: "summary" },
  );
  if (!projected.ok) throw projected.error;
  expect(projected.value.summary).toMatchObject({
    package: "hello",
    version: "1:2.03-1",
    architecture: "all",
    relationship_group_count: 6,
    maintainer_script_count: 6,
    data_entry_count: 7,
    issue_count: 0,
  });
});

it("keeps an unreadable dependency alternative as an issue and reports partial coverage", () => {
  const report = parse(
    debPackageFixture({
      controlText:
        "Package: hello\nVersion: 1.0\nArchitecture: all\nDepends: libc6 (>= 2.34), libbar (2.0) | libfoo:kfreebsd-amd64\n",
    }),
  );
  expect(report.control?.relationships.depends).toEqual([
    [
      {
        name: "libc6",
        arch_qualifier: null,
        operator: ">=",
        version: "2.34",
        arch_restriction: null,
      },
    ],
    [
      {
        name: "libfoo",
        arch_qualifier: "kfreebsd-amd64",
        operator: null,
        version: null,
        arch_restriction: null,
      },
    ],
  ]);
  expect(report.issues).toContainEqual({
    kind: "malformed",
    member: "control.tar",
    field: "Depends",
    detail: unreadableRelationshipsDetail("Depends", 1, "libbar (2.0)"),
    offset: null,
  });
  expect(report.coverage.status).toBe("partial");
});

it("reads a maintainer script interpreter when later bytes are not UTF-8", () => {
  const body = Buffer.concat([
    Buffer.from("#!/bin/sh\n# ", "utf8"),
    Buffer.alloc(300, 0xff),
    Buffer.from("\nexit 0\n", "utf8"),
  ]);
  const report = parse(
    debPackageFixture({
      controlEntries: [
        {
          name: "./control",
          content: "Package: hello\nVersion: 1.0\nArchitecture: all\n",
        },
        { name: "./postinst", content: body },
      ],
    }),
  );
  expect(report.control?.maintainer_scripts).toEqual([
    { name: "postinst", interpreter: "/bin/sh", bytes: body.length },
  ]);
});

it("records one bounded issue for a field with many unreadable alternatives", () => {
  const report = parse(
    debPackageFixture({
      controlText: `Package: hello\nVersion: 1.0\nArchitecture: all\nDepends: libc6${" | (".repeat(5000)}\n`,
    }),
  );
  const depends = report.issues.filter((issue) => issue.field === "Depends");
  expect(depends).toHaveLength(1);
  expect(depends[0]?.detail).toBe(
    unreadableRelationshipsDetail("Depends", 5000, "("),
  );
});

it("refuses a run of PAX headers with no entry before it costs work", () => {
  const headers = Array.from({ length: 9 }, (_, index) => ({
    name: `./PaxHeaders/${String(index)}`,
    type: "x",
    content: paxRecord(`key${String(index)}`, "value"),
  }));
  const error = expectFailure(
    () =>
      parse(
        debPackageFixture({
          dataEntries: [...headers, { name: "./usr/bin/h", content: "" }],
        }),
      ),
    DebPackageAllowanceFailure,
  );
  expect(error.failure).toMatchObject({
    kind: "limit",
    limit: { name: "tar_extension_headers", maximum: 8 },
  });
  expect(error.partial?.control?.package).toBe("hello");
});

it("accepts the few PAX and GNU headers a real entry uses", () => {
  const report = parse(
    debPackageFixture({
      dataEntries: [
        { name: "./", type: "5", mode: 0o755, content: "" },
        {
          name: "./PaxHeaders/a",
          type: "x",
          content: Buffer.concat([
            paxRecord("mtime", "1"),
            paxRecord("path", "./usr/share/a"),
          ]),
        },
        { name: "./usr/share/a", content: "" },
      ],
    }),
  );
  expect(report.data_entries.map((entry) => entry.path)).toContain(
    "usr/share/a",
  );
});

it("applies PAX owner records over the fixed header fields", () => {
  const report = parse(
    debPackageFixture({
      dataEntries: [
        { name: "./", type: "5", mode: 0o755, content: "" },
        {
          name: "./PaxHeaders/owned",
          type: "x",
          content: Buffer.concat([
            paxRecord("uid", "3000000"),
            paxRecord("gid", "3000001"),
            paxRecord("uname", "a-very-long-user-name-beyond-32-bytes"),
            paxRecord("gname", "builders"),
          ]),
        },
        { name: "./usr/share/owned", content: "", uname: "trunc", gname: "x" },
      ],
    }),
  );
  expect(
    report.data_entries.find((entry) => entry.path === "usr/share/owned"),
  ).toMatchObject({
    uid: 3000000,
    gid: 3000001,
    user: "a-very-long-user-name-beyond-32-bytes",
    group: "builders",
  });
});

/** The fixture writes `/0/`; GNU ar writes a string-table reference as `/0`. */
const gnuLongNameReferences = (bytes: Buffer): Buffer => {
  const copy = Buffer.from(bytes);
  for (
    let at = copy.indexOf("/0/ ");
    at !== -1;
    at = copy.indexOf("/0/ ", at + 1)
  )
    copy[at + 2] = 0x20;
  return copy;
};

it("refuses a GNU ar long name above the name limit before repeating it", () => {
  const longName = "n".repeat(4097);
  const bytes = gnuLongNameReferences(
    debPackageFixture({
      extraMembers: [
        { name: "//", data: Buffer.from(`${longName}/\n`) },
        { name: "/0", data: Buffer.alloc(0) },
        { name: "/0", data: Buffer.alloc(0) },
      ],
    }),
  );
  const error = expectFailure(() => parse(bytes), DebPackageAllowanceFailure);
  expect(error.failure).toMatchObject({
    kind: "limit",
    limit: { name: "ar_member_name_bytes", maximum: 4096 },
  });
  expect(error.message).toContain(
    "4097 bytes exceeds the 4096-byte name limit",
  );
  expect(error.partial?.ar.format_version).toBe("2.0");
});

it("resolves a GNU ar long name at the name limit", () => {
  const longName = "n".repeat(4096);
  const report = parse(
    gnuLongNameReferences(
      debPackageFixture({
        extraMembers: [
          { name: "//", data: Buffer.from(`${longName}/\n`) },
          { name: "/0", data: Buffer.alloc(0) },
        ],
      }),
    ),
  );
  expect(report.ar.extra_member_names).toContain(longName);
});

it.for([
  [
    "past the end of the string table",
    "/40",
    /outside the 18-byte string table/u,
  ],
  ["at an empty string-table entry", "/17", /empty string-table entry/u],
] as const)(
  "refuses a GNU ar long name reference %s with the partial report",
  ([, reference, message]) => {
    const fixture = debPackageFixture({
      extraMembers: [
        { name: "//", data: Buffer.from("long-member-name/\n") },
        { name: reference, data: Buffer.alloc(0) },
      ],
    });
    // The fixture writes `/40/`; GNU ar writes the reference as `/40`.
    const bytes = Buffer.from(fixture);
    bytes[bytes.indexOf(`${reference}/ `) + reference.length] = 0x20;
    const error = expectFailure(() => parse(bytes), DebPackageFormatFailure);
    expect(error.kind).toBe("malformed");
    expect(error.message).toMatch(message);
    expect(error.partial?.artifact.sha256).toBe("a".repeat(64));
    expect(error.partial?.ar.format_version).toBe("2.0");
    expect(error.partial?.ar.members.map((member) => member.name)).toContain(
      "//",
    );
  },
);

it("keeps a GNU ar string table as a counted member", () => {
  const bytes = debPackageFixture({
    extraMembers: [{ name: "//", data: Buffer.from("long-member-name/\n") }],
  });
  const report = parse(bytes);
  expect(report.ar.members.map((member) => member.name)).toContain("//");
  expect(report.ar.extra_member_names).toContain("//");
  expect(report.coverage.status).toBe("partial");
  const error = expectFailure(
    () => parse(bytes, { max_ar_members: 3 }),
    DebPackageCapacityFailure,
  );
  expect(error.resource).toBe("max_ar_members");
});

it.for([
  ["a partial next header", 100],
  ["missing member padding", -200],
] as const)("refuses a control tar cut off with %s", ([, cut]) => {
  const first = tarMember({ name: "./control", content: "Package: hello\n" });
  const second = tarMember({ name: "./md5sums", content: "x".repeat(300) });
  const tar =
    cut > 0
      ? Buffer.concat([first, second.subarray(0, cut)])
      : Buffer.concat([first, second.subarray(0, second.length + cut)]);
  const error = expectFailure(
    () => parse(debPackageFixture({ controlMemberBytes: gzipSync(tar) })),
    DebPackageFormatFailure,
  );
  expect(error.kind).toBe("truncated");
});

it("reads an entry whose PAX size record overrides its header size", () => {
  const control = Buffer.from(DEFAULT_CONTROL_TEXT, "utf8");
  const block = Buffer.alloc(Math.ceil(control.length / 512) * 512);
  block.set(control);
  const tar = Buffer.concat([
    tarMember({
      name: "./PaxHeaders/control",
      type: "x",
      content: paxRecord("size", String(control.length)),
    }),
    // The ustar header says 0 bytes; the PAX record carries the real size.
    tarMember({ name: "./control" }),
    block,
    Buffer.alloc(1024),
  ]);
  const report = parse(
    debPackageFixture({ controlMemberBytes: gzipSync(tar) }),
  );
  expect(report.control?.package).toBe("hello");
});

it("ignores the prefix region of GNU tar headers", () => {
  // GNU headers use "ustar  \0" and store atime at 345, not a path prefix.
  const gnu = (member: Buffer): Buffer => {
    const header = member.subarray(0, 512);
    header.write("ustar  \0", 257, "latin1");
    header.write("15020342231\0", 345, "latin1");
    header.write("        ", 148);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    return member;
  };
  const tar = Buffer.concat([
    gnu(tarMember({ name: "./control", content: DEFAULT_CONTROL_TEXT })),
    Buffer.alloc(1024),
  ]);
  const report = parse(
    debPackageFixture({ controlMemberBytes: gzipSync(tar) }),
  );
  expect(report.control?.package).toBe("hello");
});

it("compares md5sums lines whose names GNU md5sum escaped", () => {
  const report = parse(
    debPackageFixture({
      md5sums: [
        `\\${"0".repeat(32)}  usr/share/doc/a\\\\b`,
        "not a digest line",
        "",
      ].join("\n"),
      dataEntries: [{ name: "./usr/share/doc/a\\b", content: "x" }],
    }),
  );
  expect(report.md5sums_cross_check).toMatchObject({
    listed: 1,
    present: 1,
    missing_from_md5sums: 0,
  });
  expect(report.limitations).toContain(
    "1 md5sums line(s) are not md5sum digest lines and were not compared.",
  );
});

it("applies a global PAX record to every later entry", () => {
  const report = parse(
    debPackageFixture({
      dataEntries: [
        {
          name: "./pax_global_header",
          type: "g",
          content: paxRecord("uid", "3000000"),
        },
        { name: "./usr/share/doc/one", content: "1" },
        { name: "./usr/share/doc/two", content: "2" },
      ],
    }),
  );
  const uids = report.data_entries
    .filter((entry) => entry.path.startsWith("usr/share/doc/"))
    .map((entry) => entry.uid);
  expect(uids).toEqual([3_000_000, 3_000_000]);
});

it("charges a global PAX value repeated into every row to the data byte budget", () => {
  const owner = "u".repeat(16 * 1024);
  const bytes = debPackageFixture({
    dataEntries: [
      {
        name: "./pax_global_header",
        type: "g",
        content: paxRecord("uname", owner),
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        name: `./usr/share/doc/${String(index)}`,
      })),
    ],
  });
  const error = expectFailure(
    () => parse(bytes, { max_data_bytes: 64 * 1024 }),
    DebPackageCapacityFailure,
  );
  expect(error.resource).toBe("max_data_bytes");
  expect(error.message).toMatch(/global PAX text repeated/u);
  expect(error.partial?.data_entries.length).toBeLessThan(8);
  const report = parse(bytes, { max_data_bytes: 256 * 1024 });
  expect(
    report.data_entries
      .filter((entry) => entry.path.startsWith("usr/share/doc/"))
      .every((entry) => entry.user === owner),
  ).toBe(true);
});

it("parses a long global PAX owner once rather than per entry", () => {
  const uid = `${"0".repeat(4 * 1024 * 1024)}7`;
  const bytes = debPackageFixture({
    dataEntries: [
      {
        name: "./pax_global_header",
        type: "g",
        content: Buffer.concat([paxRecord("uid", uid), paxRecord("gid", uid)]),
      },
      ...Array.from({ length: 2048 }, (_, index) => ({
        name: `./usr/share/doc/${String(index)}`,
      })),
    ],
  });
  const started = performance.now();
  const report = parse(bytes, { max_data_bytes: 32 * 1024 * 1024 });
  expect(performance.now() - started).toBeLessThan(2000);
  const docs = report.data_entries.filter((entry) =>
    entry.path.startsWith("usr/share/doc/"),
  );
  expect(docs).toHaveLength(2048);
  expect(docs.every((entry) => entry.uid === 7 && entry.gid === 7)).toBe(true);
});

it("restores header owners when a later global PAX record clears the override", () => {
  const report = parse(
    debPackageFixture({
      dataEntries: [
        {
          name: "./pax_global_header",
          type: "g",
          content: paxRecord("uname", "alice"),
        },
        { name: "./usr/share/doc/one", content: "1", uname: "builder" },
        {
          name: "./pax_global_header",
          type: "g",
          content: paxRecord("uname", ""),
        },
        { name: "./usr/share/doc/two", content: "2", uname: "builder" },
      ],
    }),
  );
  const users = report.data_entries
    .filter((entry) => entry.path.startsWith("usr/share/doc/"))
    .map((entry) => entry.user);
  expect(users).toEqual(["alice", "builder"]);
});

it("trims a long slash run in a PAX path in linear time", () => {
  const name = `${"/".repeat(256 * 1024)}a`;
  const started = performance.now();
  const report = parse(
    debPackageFixture({
      dataEntries: [
        {
          name: "./PaxHeaders/file",
          type: "x",
          content: paxRecord("path", name),
        },
        { name: "./usr/share/doc/file", content: "x" },
      ],
    }),
  );
  expect(performance.now() - started).toBeLessThan(2000);
  expect(report.data_entries.some((entry) => entry.path === name)).toBe(true);
});

it("refuses a PAX extended header whose record cannot be read", () => {
  const error = expectFailure(
    () =>
      parse(
        debPackageFixture({
          dataEntries: [
            { name: "./PaxHeaders/file", type: "x", content: "99 path=abc\n" },
            { name: "./usr/share/doc/file", content: "x" },
          ],
        }),
      ),
    DebPackageFormatFailure,
  );
  expect(error.kind).toBe("malformed");
  expect(error.message).toMatch(/unreadable record/u);
});

it("refuses relationship fields past the alternatives allowance before building them", () => {
  const error = expectFailure(
    () =>
      parse(
        debPackageFixture({
          controlText: `${DEFAULT_CONTROL_TEXT}Depends: ${Array(65_537).fill("a").join("|")}\n`,
        }),
      ),
    DebPackageAllowanceFailure,
  );
  expect(error.failure).toMatchObject({
    kind: "limit",
    limit: { name: "relationship_alternatives", maximum: 65_536 },
  });
  expect(error.message).toMatch(/more than 65536 alternatives/u);
  expect(error.partial?.ar.format_version).toBe("2.0");
});
