import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { DEB_PACKAGE_TOOL_CONTRACTS } from "../../src/contracts/deb/debPackageToolContracts.js";
import { debPackageSchema } from "../../src/domain/deb/debPackage.js";
import {
  debPackageFixture,
  notArBytes,
  paxRecord,
} from "../../src/deb/DebPackage.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const debContract = DEB_PACKAGE_TOOL_CONTRACTS.find(
  (item) => item.name === "inspect_deb_package",
);
if (debContract === undefined)
  throw new Error("Missing inspect_deb_package contract");
const completeDebEvidenceSchema = debContract.outputSchema.safeExtend({
  normalized_result: debPackageSchema,
});

cliTest(
  "inspects a fixture .deb without installing it or running maintainer scripts",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-deb-cli-");
    const path = join(root, "hello_2.03-1_all.deb");
    const bytes = debPackageFixture();
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-deb-package", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = completeDebEvidenceSchema.parse(result.json);
    expect(evidence.normalized_result).toMatchObject({
      artifact: {
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      },
      ar: { format_version: "2.0" },
      control: {
        package: "hello",
        version: { raw: "1:2.03-1", epoch: 1 },
        architecture: "all",
        maintainer_scripts: expect.arrayContaining([
          { name: "preinst", interpreter: "/bin/sh", bytes: 17 },
        ]),
      },
    });
    expect(
      evidence.normalized_result.control?.relationships.depends?.[1],
    ).toEqual([
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
    ]);
    expect(
      evidence.normalized_result.data_entries.some(
        (entry) => entry.path === "usr/bin/hello" && entry.type === "file",
      ),
    ).toBe(true);
  },
);

cliTest("refuses a file that is not a Debian ar archive", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-deb-cli-malformed-");
  const path = join(root, "not.deb");
  await writeFile(path, notArBytes());
  const result = await cli.run({
    arguments: ["inspect-deb-package", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "unsupported_target",
    details: {
      operation: "inspect_deb_package",
      failure_kind: "malformed",
      format: "deb",
      reason: expect.stringContaining("ar magic"),
    },
  });
});

cliTest("inspects xz-compressed control and data members", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-deb-cli-xz-");
  const path = join(root, "hello.xz.deb");
  const bytes = debPackageFixture({
    controlCompression: "xz",
    dataCompression: "xz",
  });
  await writeFile(path, bytes);
  const result = await cli.run({
    arguments: ["inspect-deb-package", path, "--json"],
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const evidence = completeDebEvidenceSchema.parse(result.json);
  expect(evidence.normalized_result.control?.package).toBe("hello");
  expect(
    evidence.normalized_result.ar.members.map((member) => member.name),
  ).toEqual(["debian-binary", "control.tar.xz", "data.tar.xz"]);
});

cliTest(
  "matches md5sums paths containing Unicode line separators",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-deb-cli-md5-unicode-");
    const path = join(root, "unicode-paths.deb");
    const names = ["usr/share/doc/a\u2028b", "usr/share/doc/c\u2029"];
    const bytes = debPackageFixture({
      conffiles: null,
      scripts: false,
      md5sums: names.map((name) => `${"0".repeat(32)}  ${name}\n`).join(""),
      dataEntries: names.map((name) => ({ name: `./${name}`, content: "x" })),
    });
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-deb-package", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = completeDebEvidenceSchema.parse(result.json);
    expect(
      evidence.normalized_result.data_entries.map((entry) => entry.path),
    ).toEqual(names);
    expect(evidence.normalized_result.md5sums_cross_check).toEqual({
      listed: 2,
      present: 2,
      missing_from_inventory: 0,
      missing_from_md5sums: 0,
    });
  },
);

cliTest(
  "keeps length-delimited PAX text distinct from NUL-terminated header fields",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-deb-pax-nul-");
    const path = join(root, "nul.deb");
    const bytes = debPackageFixture({
      controlEntries: [
        {
          name: "./control",
          content: "Package: actual\nVersion: 1\nArchitecture: all\n",
        },
        {
          name: "local",
          type: "x",
          content: paxRecord("path", "./control\0suffix"),
        },
        {
          name: "./header",
          content: "Package: spoofed\nVersion: 1\nArchitecture: all\n",
        },
      ],
      dataEntries: [
        {
          name: "global",
          type: "g",
          content: Buffer.concat([
            paxRecord("uname", "alice\0suffix"),
            paxRecord("gname", "staff\0suffix"),
          ]),
        },
        {
          name: "local",
          type: "x",
          content: Buffer.concat([
            paxRecord("path", "./one\0suffix"),
            paxRecord("linkpath", "target\0suffix"),
          ]),
        },
        { name: "./header-link", type: "2", linkname: "header-target" },
        {
          name: "local",
          type: "x",
          content: paxRecord("path", "./one\0other"),
        },
        { name: "./header-file", content: "payload" },
      ],
    });
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-deb-package", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = completeDebEvidenceSchema.parse(result.json);
    expect(evidence.normalized_result).toMatchObject({
      artifact: {
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      control: { package: "actual" },
      data_entries: [
        {
          path: "one\0suffix",
          type: "symlink",
          link_target: "target\0suffix",
          user: "alice\0suffix",
          group: "staff\0suffix",
        },
        {
          path: "one\0other",
          type: "file",
          size: 7,
          user: "alice\0suffix",
          group: "staff\0suffix",
        },
      ],
    });
  },
);
