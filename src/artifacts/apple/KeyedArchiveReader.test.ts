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
