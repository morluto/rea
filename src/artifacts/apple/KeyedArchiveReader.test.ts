import { describe, expect, it } from "vitest";
import { build, buildBinary, type PlistValue } from "plist";
import { decodeKeyedArchiveBytes } from "./KeyedArchiveReader.js";
import { deeplyNestedXmlPlist } from "../../../tests/fixtures/keyedArchiveXmlNesting.js";

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
  it.each(["bplist00", "NIBArchive"])(
    "rejects high-bit mutations of %s as malformed bytes rather than another archive kind",
    (signature) => {
      for (let index = 0; index < signature.length; index += 1) {
        const bytes = Buffer.from(signature);
        bytes[index] = (bytes[index] ?? 0) | 0x80;
        expect(() =>
          decodeKeyedArchiveBytes(bytes, { offset: 0, limit: 1 }),
        ).toThrow(
          expect.objectContaining({
            code: "ERR_ENCODING_INVALID_ENCODED_DATA",
          }),
        );
      }
    },
  );

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
  it("reports a binary archive dictionary keyed __proto__ as omitted", () => {
    const placeholder = "proto_key";
    const encoded = Buffer.from(
      buildBinary({
        ...archive,
        [placeholder]: "hidden",
        $objects: ["$null", "value"],
      }),
    );
    const start = encoded.indexOf(placeholder);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(encoded.indexOf(placeholder, start + placeholder.length)).toBe(-1);
    Buffer.from("__proto__").copy(encoded, start);

    const graph = decodeKeyedArchiveBytes(encoded, { offset: 0, limit: 2 });
    expect(graph.limitations).toContain(
      "Dictionary entries keyed __proto__ were omitted because REA results cannot represent that key.",
    );
  });
  it("does not report a binary __proto__ value as an omitted key", () => {
    const graph = decodeKeyedArchiveBytes(
      Buffer.from(
        buildBinary({
          ...archive,
          note: "__proto__",
          $objects: ["$null", "value"],
        }),
      ),
      { offset: 0, limit: 2 },
    );
    expect(graph.limitations).not.toContain(
      "Dictionary entries keyed __proto__ were omitted because REA results cannot represent that key.",
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
const plistUtf16String = (value: string): Buffer => {
  const bytes = Buffer.alloc(1 + value.length * 2);
  bytes[0] = 0x60 | value.length;
  for (let index = 0; index < value.length; index += 1)
    bytes.writeUInt16BE(value.charCodeAt(index), 1 + index * 2);
  return bytes;
};
const plistExtendedUtf16String = (value: string): Buffer => {
  const bytes = Buffer.alloc(3 + value.length * 2);
  bytes.set([0x6f, 0x10, value.length]);
  for (let index = 0; index < value.length; index += 1)
    bytes.writeUInt16BE(value.charCodeAt(index), 3 + index * 2);
  return bytes;
};
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

  it("rejects an array key that coerces to __proto__ before parsing", () => {
    expect(() =>
      decodeKeyedArchiveBytes(
        keyedRoot([
          plistArray([9]),
          Buffer.from([0xd1, 0, 10, 0, 11]),
          plistArray([12]),
          Buffer.from([0xd1, 0, 13, 0, 14]),
          plistString("__proto__"),
          plistString("lost"),
          plistString("value"),
        ]),
        selection,
      ),
    ).toThrow("binary plist dictionary key is not a string");
  });

  it("rejects binary data dictionary keys", () => {
    expect(() =>
      decodeKeyedArchiveBytes(
        keyedRoot([
          plistArray([9]),
          Buffer.from([0xd1, 0, 10, 0, 11]),
          Buffer.from([0x41, 0xab]),
          plistString("value"),
        ]),
        selection,
      ),
    ).toThrow("binary plist dictionary key is not a string");
  });

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

  it("recognizes a shared key object used by separate dictionaries", () => {
    const graph = decodeKeyedArchiveBytes(
      keyedRoot([
        plistArray([9, 12]),
        Buffer.from([0xd1, 0, 10, 0, 11]),
        plistString("__proto__"),
        plistString("first"),
        Buffer.from([0xd1, 0, 10, 0, 13]),
        plistString("second"),
      ]),
      selection,
    );
    expect(graph.limitations).toContain(
      "Dictionary entries keyed __proto__ were omitted because REA results cannot represent that key.",
    );
  });

  it("reports binary omission presence without claiming a count", () => {
    const placeholder = "proto_key";
    const nested = Buffer.from(
      buildBinary({
        ...archive,
        [placeholder]: { [placeholder]: "hidden", visible: true },
        $objects: ["$null", "value"],
      }),
    );
    let index = nested.indexOf(placeholder);
    while (index !== -1) {
      Buffer.from("__proto__").copy(nested, index);
      index = nested.indexOf(placeholder, index + placeholder.length);
    }
    const nestedGraph = decodeKeyedArchiveBytes(nested, selection);
    expect(nestedGraph.limitations).toContain(
      "Dictionary entries keyed __proto__ were omitted because REA results cannot represent that key.",
    );

    const shadowedValue = keyedRoot([
      plistArray([9]),
      Buffer.from([0xd2, 0, 10, 0, 10, 0, 11, 0, 12]),
      plistString("shadow"),
      Buffer.from([0xd1, 0, 13, 0, 14]),
      plistString("replacement"),
      plistString(placeholder),
      plistString("hidden"),
    ]);
    const keyOffset = shadowedValue.indexOf(Buffer.from(placeholder));
    expect(keyOffset).toBeGreaterThanOrEqual(0);
    Buffer.from("__proto__").copy(shadowedValue, keyOffset);
    const shadowedGraph = decodeKeyedArchiveBytes(shadowedValue, selection);
    expect(shadowedGraph.limitations).toContain(
      "Dictionary entries keyed __proto__ were omitted because REA results cannot represent that key.",
    );
    expect(shadowedGraph.limitations).not.toContain(
      "1 dictionary entry keyed __proto__ was omitted because REA results cannot represent that key.",
    );
  });

  it("detects UTF-16 binary dictionary keys", () => {
    const graph = decodeKeyedArchiveBytes(
      keyedRoot([
        plistArray([9]),
        Buffer.from([0xd1, 0, 10, 0, 11]),
        plistUtf16String("__proto__"),
        plistString("hidden"),
      ]),
      selection,
    );
    expect(graph.limitations).toContain(
      "Dictionary entries keyed __proto__ were omitted because REA results cannot represent that key.",
    );
  });

  it("detects extended-length UTF-16 binary dictionary keys", () => {
    const graph = decodeKeyedArchiveBytes(
      keyedRoot([
        plistArray([9]),
        Buffer.from([0xd1, 0, 10, 0, 11]),
        plistExtendedUtf16String("__proto__"),
        plistString("hidden"),
      ]),
      selection,
    );
    expect(graph.limitations).toContain(
      "Dictionary entries keyed __proto__ were omitted because REA results cannot represent that key.",
    );
  });
});

describe("XML plist nesting preflight", () => {
  const selection = { offset: 0, limit: 1 };

  /** A valid XML NSKeyedArchiver envelope whose object 1 nests `depth` dictionaries. */
  const deeplyNestedArchive = (depth: number) => {
    let payload: PlistValue = "leaf";
    for (let level = 0; level < depth; level += 1) payload = { k: payload };
    return Buffer.from(
      build({
        $archiver: "NSKeyedArchiver",
        $version: 100000,
        $objects: ["$null", payload],
        $top: { root: { UID: 1 } },
      }),
    );
  };

  /** Follow the single-member chain of a decoded object to its deepest value. */
  const deepestValue = (value: unknown): unknown => {
    let cursor = value;
    while (
      cursor !== null &&
      typeof cursor === "object" &&
      !Array.isArray(cursor) &&
      "k" in cursor
    ) {
      cursor = (cursor as Record<string, unknown>).k;
    }
    return cursor;
  };

  it.each([129, 4000])(
    "rejects %i-level XML nesting as the documented resource limit",
    (depth) => {
      // Recursive decoding exceeds the call stack before the projection limit
      // can report it, so the decoder must reject the nesting up front with
      // the same bounded-resource error an in-reach document would produce.
      expect(() =>
        decodeKeyedArchiveBytes(
          Buffer.from(deeplyNestedXmlPlist(depth)),
          selection,
        ),
      ).toThrow(new RangeError("Plist exceeds 128 nesting levels"));
    },
  );

  it("decodes a valid XML keyed archive exactly at the nesting limit", () => {
    const graph = decodeKeyedArchiveBytes(deeplyNestedArchive(126), {
      root: "root",
      offset: 1,
      limit: 1,
    });
    expect(graph.objects).toHaveLength(1);
    expect(deepestValue(graph.objects[0]?.value)).toBe("leaf");
  });

  it("rejects one nesting level past the limit before decoding", () => {
    expect(() =>
      decodeKeyedArchiveBytes(deeplyNestedArchive(127), selection),
    ).toThrow(new RangeError("Plist exceeds 128 nesting levels"));
  });
});
