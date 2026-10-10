import { describe, expect, it } from "vitest";
import { build, buildBinary } from "plist";
import { decodeKeyedArchiveBytes } from "./KeyedArchiveReader.js";

const archive = {
  $archiver: "NSKeyedArchiver",
  $version: 100000,
  $objects: [
    "$null",
    {
      $class: { UID: 4 },
      child: { UID: 2 },
      shared: { UID: 2 },
      self: { UID: 1 },
      conditional: { UID: 0 },
      broken: { UID: 90 },
    },
    { "NS.objects": [{ UID: 1 }, { UID: 3 }] },
    "value",
    { $classname: "UnknownModel", $classes: ["UnknownModel", "NSObject"] },
  ],
  $top: { root: { UID: 1 }, other: { UID: 2 } },
};
describe("inert keyed archive decoding", () => {
  it("preserves CF$UID, malformed references and original pagination identities", () => {
    const bytes = Buffer.from(
      build({
        ...archive,
        $objects: [
          "$null",
          { bad: { CF$UID: -1 }, valid: { CF$UID: 2 }, broken: { CF$UID: 90 } },
          "value",
        ],
      }),
    );
    const graph = decodeKeyedArchiveBytes(bytes, {
      root: "root",
      offset: 1,
      limit: 1,
    });
    expect(graph.roots).toEqual({ root: { UID: 1 } });
    expect(graph.objects.map(({ id }) => id)).toEqual([1]);
    expect(graph.next_offset).toBe(2);
    expect(graph.references).toContainEqual(
      expect.objectContaining({ source: 1, target: 90, status: "unresolved" }),
    );
    expect(graph.references).toContainEqual(
      expect.objectContaining({ source: 1, target: null, status: "malformed" }),
    );
    expect(graph.references).toContainEqual(
      expect.objectContaining({ source: 1, target: 2, status: "resolved" }),
    );
  });
  it("reports an XML archive dictionary keyed __proto__ as omitted", () => {
    const xml = build({ ...archive, $objects: ["$null", "value"] }).replace(
      "<key>$top</key>",
      "<key>__proto__</key><string>x</string><key>$top</key>",
    );
    const graph = decodeKeyedArchiveBytes(Buffer.from(xml), {
      offset: 0,
      limit: 2,
    });
    expect(graph.objects.map(({ value }) => value)).toEqual(["$null", "value"]);
    expect(graph.limitations).toContain(
      "1 dictionary entry keyed __proto__ was omitted because REA results cannot represent that key.",
    );
  });
  it("rejects missing roots, malformed plist, and non-keyed archives", () => {
    expect(() =>
      decodeKeyedArchiveBytes(Buffer.from("bplist00bad"), {
        offset: 0,
        limit: 1,
      }),
    ).toThrow();
    expect(() =>
      decodeKeyedArchiveBytes(Buffer.from(build({ ...archive, $top: {} })), {
        offset: 0,
        limit: 1,
      }),
    ).toThrow("roots");
    expect(() =>
      decodeKeyedArchiveBytes(Buffer.from(build({ plain: true })), {
        offset: 0,
        limit: 1,
      }),
    ).toThrow("NSKeyedArchiver");
    expect(() =>
      decodeKeyedArchiveBytes(Buffer.from(buildBinary(archive)), {
        root: "missing",
        offset: 0,
        limit: 1,
      }),
    ).toThrow(
      expect.objectContaining({
        issues: [
          expect.objectContaining({
            path: ["root"],
            message: expect.stringContaining("does not exist"),
            expected: ["root", "other"],
          }),
        ],
      }),
    );
  });
});

/** Encode a bplist00 whose objects reference each other by index. */
const binaryPlist = (objects: readonly Buffer[]): Buffer => {
  const header = Buffer.from("bplist00");
  const offsets: number[] = [];
  let position = header.length;
  for (const object of objects) {
    offsets.push(position);
    position += object.length;
  }
  const table = Buffer.alloc(objects.length * 4);
  offsets.forEach((offset, index) => table.writeUInt32BE(offset, index * 4));
  const trailer = Buffer.alloc(32);
  trailer[6] = 4;
  trailer[7] = 2;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(position), 24);
  return Buffer.concat([header, ...objects, table, trailer]);
};
const plistArray = (references: readonly number[]): Buffer => {
  const bytes = Buffer.alloc(1 + references.length * 2);
  bytes[0] = 0xa0 | references.length;
  references.forEach((reference, index) =>
    bytes.writeUInt16BE(reference, 1 + index * 2),
  );
  return bytes;
};
const plistString = (value: string): Buffer =>
  Buffer.concat([Buffer.from([0x50 | value.length]), Buffer.from(value)]);
// {"$archiver": "NSKeyedArchiver", "$top": {"root": UID 1}, "$objects": object 8}
const keyedRoot = (payload: readonly Buffer[]): Buffer =>
  binaryPlist([
    Buffer.from([0xd3, 0, 1, 0, 3, 0, 4, 0, 2, 0, 8, 0, 5]),
    plistString("$archiver"),
    Buffer.concat([
      Buffer.from([0x5f, 0x10, 15]),
      Buffer.from("NSKeyedArchiver"),
    ]),
    plistString("$objects"),
    plistString("$top"),
    Buffer.from([0xd1, 0, 6, 0, 7]),
    plistString("root"),
    Buffer.from([0x80, 1]),
    ...payload,
  ]);

describe("binary plist reference preflight", () => {
  const selection = { offset: 0, limit: 10 };

  it("reports a reference cycle as malformed, not as an oversized archive", () => {
    expect(() =>
      decodeKeyedArchiveBytes(keyedRoot([plistArray([8])]), selection),
    ).toThrow(
      new TypeError(
        "binary plist object references form a cycle, which a property list cannot represent",
      ),
    );
  });

  it("rejects exponential shared-container expansion before decoding", () => {
    // Forty levels of [next, next] expand to 2^40 leaves in a few hundred bytes.
    const levels = Array.from({ length: 40 }, (_, index) =>
      plistArray([9 + index, 9 + index]),
    );
    expect(() =>
      decodeKeyedArchiveBytes(
        keyedRoot([...levels, plistString("x")]),
        selection,
      ),
    ).toThrow(RangeError);
  });

  it("decodes shared leaf references", () => {
    const decoded = decodeKeyedArchiveBytes(
      keyedRoot([plistArray([9, 9, 9]), plistString("$null")]),
      selection,
    );
    expect(decoded.objects.map(({ id, value }) => [id, value])).toEqual([
      [0, "$null"],
      [1, "$null"],
      [2, "$null"],
    ]);
  });
});
