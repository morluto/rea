import { afterEach, expect, it } from "vitest";

import { inspectDebPackageInputSchema } from "../domain/deb/debPackage.js";
import { projectDebPackageView } from "../domain/analysisView/debPackageView.js";
import {
  DebPackageCapacityFailure,
  DebPackageFormatFailure,
} from "./DebPackage.errors.js";
import {
  debPackageFixture,
  notArBytes,
  truncatedAfterDebianBinaryBytes,
  truncatedArMemberBytes,
  xzStub,
} from "./DebPackage.fixture.js";
import {
  DEB_PACKAGE_LIMITATIONS,
  parseDebPackage,
} from "./DebPackageParser.js";
import { replaceXzBindingForTests } from "./xzDecoder.js";

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
  expect(report.limitations.join("\n")).not.toContain("not UTF-8");
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
  expect(report.limitations).toContain(
    "1 tar entry names or link targets are not UTF-8; they are shown with U+FFFD replacements and may not match md5sums.",
  );
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
