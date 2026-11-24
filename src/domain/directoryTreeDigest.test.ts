import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  DirectoryTreeDigestBuilder,
  directoryTreeDigest,
  type DirectoryTreeRecord,
} from "./directoryTreeDigest.js";

const u32 = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};
const u64 = (value: number) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
};
const field = (text: string | Buffer) => {
  const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : text;
  return Buffer.concat([u64(bytes.length), bytes]);
};

/** The documented version 1 encoding, written out independently of the owner. */
const specified = (...records: readonly Buffer[]) =>
  createHash("sha256")
    .update(
      Buffer.concat([
        Buffer.from("rea-directory-tree\0", "utf8"),
        u32(1),
        u64(records.length),
        ...records,
      ]),
    )
    .digest("hex");

const fileSha = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const tree: readonly DirectoryTreeRecord[] = [
  { kind: "file", path: "bin/app.exe", sha256: fileSha("MZ") },
  { kind: "directory", path: "bin" },
  { kind: "directory", path: "shaders" },
  { kind: "file", path: "shaders/a.spv", sha256: fileSha("spirv") },
  {
    kind: "symlink",
    path: "latest",
    targetHex: Buffer.from("bin").toString("hex"),
  },
  { kind: "fifo", path: "pipe" },
];

describe("directory tree digest", () => {
  it("hashes the empty directory as the header with no members", () => {
    expect(directoryTreeDigest([])).toBe(specified());
    expect(directoryTreeDigest([])).toBe(
      // printf "rea-directory-tree\0\0\0\0\1" plus eight zero bytes, through shasum -a 256.
      "b28a57a57239d69019456fc9079821c5f31911fc656d15ff77703cb13991b3b6",
    );
  });

  it("matches the documented byte encoding in canonical path order", () => {
    expect(directoryTreeDigest(tree)).toBe(
      specified(
        Buffer.concat([Buffer.of(0x02), field("bin")]),
        Buffer.concat([
          Buffer.of(0x01),
          field("bin/app.exe"),
          Buffer.from(fileSha("MZ"), "hex"),
        ]),
        Buffer.concat([Buffer.of(0x03), field("latest"), field("bin")]),
        Buffer.concat([Buffer.of(0x04), field("pipe")]),
        Buffer.concat([Buffer.of(0x02), field("shaders")]),
        Buffer.concat([
          Buffer.of(0x01),
          field("shaders/a.spv"),
          Buffer.from(fileSha("spirv"), "hex"),
        ]),
      ),
    );
  });

  it("is independent of walk order", () => {
    expect(directoryTreeDigest([...tree].reverse())).toBe(
      directoryTreeDigest(tree),
    );
  });

  it("orders by UTF-8 bytes, which is code point order, not UTF-16 order", () => {
    // U+FF61 sorts before U+1F600 by code point; UTF-16 code units would
    // place the surrogate pair 0xD83D first.
    const records: DirectoryTreeRecord[] = [
      { kind: "directory", path: "\u{1F600}" },
      { kind: "directory", path: "｡" },
    ];
    expect(directoryTreeDigest(records)).toBe(
      specified(
        Buffer.concat([Buffer.of(0x02), field("｡")]),
        Buffer.concat([Buffer.of(0x02), field("\u{1F600}")]),
      ),
    );
  });

  it.each<[string, readonly DirectoryTreeRecord[]]>([
    [
      "one content byte",
      tree.map((record) =>
        record.path === "shaders/a.spv"
          ? { ...record, sha256: fileSha("spirw") }
          : record,
      ),
    ],
    [
      "a name",
      tree.map((record) =>
        record.path === "pipe" ? { ...record, path: "pipe2" } : record,
      ),
    ],
    [
      "a kind",
      tree.map((record) =>
        record.path === "pipe" ? { kind: "socket", path: "pipe" } : record,
      ),
    ],
    [
      "a symlink target",
      tree.map((record) =>
        record.kind === "symlink"
          ? { ...record, targetHex: Buffer.from("shaders").toString("hex") }
          : record,
      ),
    ],
    ["an added member", [...tree, { kind: "directory", path: "empty" }]],
    ["a removed member", tree.filter((record) => record.path !== "pipe")],
  ])("changes with %s", (_change, changed) => {
    expect(directoryTreeDigest(changed)).not.toBe(directoryTreeDigest(tree));
  });

  it("keeps file and symlink fields unambiguous", () => {
    // A path whose bytes spell another record's fields cannot collide.
    expect(directoryTreeDigest([{ kind: "directory", path: "a" }])).not.toBe(
      directoryTreeDigest([{ kind: "directory", path: "a\u0002" }]),
    );
  });

  it("refuses a path that is not an exact relative path", () => {
    for (const path of ["", "/abs", "a//b", "./a", "a/..", "a\0b", "\uD800"])
      expect(() => directoryTreeDigest([{ kind: "directory", path }])).toThrow(
        TypeError,
      );
  });

  it("hashes names by their exact bytes, never by a normalized form", () => {
    const composed = "é";
    const decomposed = "é";
    expect(composed.normalize("NFC")).toBe(decomposed.normalize("NFC"));
    expect(
      directoryTreeDigest([{ kind: "directory", path: composed }]),
    ).not.toBe(directoryTreeDigest([{ kind: "directory", path: decomposed }]));
    // Two members that share a normalized spelling stay two members, so
    // swapping their contents changes the identity.
    const tree = (left: string, right: string) =>
      directoryTreeDigest([
        { kind: "file", path: composed, sha256: fileSha(left) },
        { kind: "file", path: decomposed, sha256: fileSha(right) },
      ]);
    expect(tree("one", "two")).not.toBe(tree("two", "one"));
  });
});

describe("directory tree digest builder", () => {
  it("reports a complete digest and member count", () => {
    const builder = new DirectoryTreeDigestBuilder();
    for (const record of tree) builder.add(record);
    expect(builder.finish()).toEqual({
      algorithm: "rea-directory-tree",
      version: 1,
      status: "complete",
      sha256: directoryTreeDigest(tree),
      member_count: tree.length,
    });
  });

  it("reports a stopped walk as partial with no digest", () => {
    const builder = new DirectoryTreeDigestBuilder();
    for (const record of tree) builder.add(record);
    builder.incomplete("limit reached");
    builder.incomplete("limit reached");
    const partial = builder.finish();
    expect(partial).toEqual({
      algorithm: "rea-directory-tree",
      version: 1,
      status: "partial",
      limitations: ["limit reached"],
    });
    expect(partial).not.toHaveProperty("sha256");
  });
});
