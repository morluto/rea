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
  it.each(["binary", "xml"])(
    "preserves shared, cyclic, nil, unresolved, and class identities in %s",
    (format) => {
      const bytes =
        format === "binary"
          ? Buffer.from(buildBinary(archive))
          : Buffer.from(build(archive));
      const graph = decodeKeyedArchiveBytes(bytes, { offset: 0, limit: 20000 });
      expect(graph.total_objects).toBe(5);
      expect(graph.objects[1]).toMatchObject({
        id: 1,
        class_id: 4,
        class_name: "UnknownModel",
        status: "unknown-class",
      });
      expect(
        graph.references.filter(
          ({ source, target }) => source === 1 && target === 2,
        ),
      ).toHaveLength(2);
      expect(graph.references).toContainEqual(
        expect.objectContaining({ source: 1, target: 1, status: "resolved" }),
      );
      expect(graph.references).toContainEqual(
        expect.objectContaining({ target: 0, status: "nil" }),
      );
      expect(graph.references).toContainEqual(
        expect.objectContaining({ target: 90, status: "unresolved" }),
      );
      expect(graph.objects[1]?.value).not.toHaveProperty("missing");
    },
  );
  it("preserves CF$UID, malformed references and original pagination identities", () => {
    const bytes = Buffer.from(
      build({
        ...archive,
        $objects: [
          "$null",
          { bad: { CF$UID: -1 }, valid: { CF$UID: 2 } },
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
      expect.objectContaining({ source: 1, target: null, status: "malformed" }),
    );
    expect(graph.references).toContainEqual(
      expect.objectContaining({ source: 1, target: 2, status: "resolved" }),
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
    ).toThrow("does not exist");
  });
});
