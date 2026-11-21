import { expect, it } from "vitest";

import {
  debArMemberRole,
  debArchiveCompressionFromName,
  inspectDebPackageInputSchema,
  parseDebianDependency,
  parseDebianRelationshipField,
  parseDebianVersion,
} from "./debPackage.js";

it("splits Debian versions into epoch, upstream, and revision without inventing parts", () => {
  expect(parseDebianVersion("1:2.03-1")).toEqual({
    raw: "1:2.03-1",
    epoch: 1,
    upstream: "2.03",
    revision: "1",
  });
  expect(parseDebianVersion("2.03")).toEqual({
    raw: "2.03",
    epoch: null,
    upstream: "2.03",
    revision: null,
  });
  expect(parseDebianVersion("1.0-1ubuntu2")).toEqual({
    raw: "1.0-1ubuntu2",
    epoch: null,
    upstream: "1.0",
    revision: "1ubuntu2",
  });
});

it("parses relationship alternatives, operators, and architecture qualifiers", () => {
  expect(parseDebianDependency("libc6 (>= 2.34)")).toEqual({
    name: "libc6",
    arch_qualifier: null,
    operator: ">=",
    version: "2.34",
    arch_restriction: null,
  });
  expect(parseDebianDependency("python3:any")).toEqual({
    name: "python3",
    arch_qualifier: "any",
    operator: null,
    version: null,
    arch_restriction: null,
  });
  expect(parseDebianDependency("foo [amd64 i386]")).toEqual({
    name: "foo",
    arch_qualifier: null,
    operator: null,
    version: null,
    arch_restriction: {
      negated: false,
      architectures: ["amd64", "i386"],
    },
  });
  expect(parseDebianDependency("bar (>= 1.0) [!armel]")).toEqual({
    name: "bar",
    arch_qualifier: null,
    operator: ">=",
    version: "1.0",
    arch_restriction: { negated: true, architectures: ["armel"] },
  });
  expect(
    parseDebianRelationshipField(
      "libc6 (>= 2.34), python3:any | python3-minimal (>= 3.11)",
    ).groups,
  ).toEqual([
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
  ]);
});

it("classifies ar member roles and compression from stored names", () => {
  expect(debArMemberRole("debian-binary")).toBe("debian-binary");
  expect(debArMemberRole("control.tar.gz")).toBe("control");
  expect(debArMemberRole("data.tar.zst")).toBe("data");
  expect(debArMemberRole("_gpgorigin")).toBe("unknown");
  expect(debArchiveCompressionFromName("control.tar")).toBe("none");
  expect(debArchiveCompressionFromName("data.tar.gz")).toBe("gzip");
  expect(debArchiveCompressionFromName("control.tar.zst")).toBe("zstd");
  expect(debArchiveCompressionFromName("data.tar.xz")).toBe("xz");
});

it("requires an absolute path and rejects extra inspection arguments", () => {
  expect(
    inspectDebPackageInputSchema.safeParse({ path: "hello.deb" }).success,
  ).toBe(false);
  expect(
    inspectDebPackageInputSchema.safeParse({
      path: "/artifacts/hello.deb",
      extra: true,
    }).success,
  ).toBe(false);
  expect(
    inspectDebPackageInputSchema.parse({ path: "/artifacts/hello.deb" }).path,
  ).toBe("/artifacts/hello.deb");
});

it("reads hyphenated architecture qualifiers", () => {
  expect(parseDebianDependency("libfoo:kfreebsd-amd64")).toMatchObject({
    name: "libfoo",
    arch_qualifier: "kfreebsd-amd64",
  });
});

it("returns relationship alternatives it cannot read, as written", () => {
  expect(
    parseDebianRelationshipField("libc6 (>= 2.34), libbar (2.0) | libbaz"),
  ).toEqual({
    groups: [
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
          name: "libbaz",
          arch_qualifier: null,
          operator: null,
          version: null,
          arch_restriction: null,
        },
      ],
    ],
    unreadCount: 1,
    firstUnread: "libbar (2.0)",
  });
});
