import { describe, expect, it } from "vitest";

import {
  MAX_MANIFEST_BYTES,
  readAndroidManifest,
} from "./AndroidManifestReader.js";
import {
  chunk,
  document,
  endElement,
  foreignChunkCarryingAttribute,
  giantString,
  startElement,
  stringPool,
} from "./axmlBuilder.fixture.js";

const STRINGS = [
  "manifest",
  "package",
  "split",
  "configForSplit",
  "dev.rea",
  "config.en",
  "feature_x",
];
const valid = (): Buffer =>
  document(
    stringPool(STRINGS),
    startElement(0, [
      { name: 1, value: 4 },
      { name: 2, value: 5 },
      { name: 3, value: 6 },
    ]),
    endElement(0),
  );

describe("readAndroidManifest (hand-built manifests)", () => {
  it("reads unnamespaced package, split and configForSplit", () => {
    expect(readAndroidManifest(valid())).toMatchObject({
      ok: true,
      value: {
        package: "dev.rea",
        split: "config.en",
        config_for_split: "feature_x",
        version_code: null,
        is_feature_split: null,
        unresolved_attributes: [],
      },
    });
  });
});

describe("readAndroidManifest (UTF-8 string pool)", () => {
  const LONG_SPLIT = `config.${"x".repeat(200)}`;
  const utf8Doc = (): Buffer =>
    document(
      stringPool(
        ["manifest", "package", "split", "dev.rea.ação", LONG_SPLIT],
        [],
        "utf8",
      ),
      startElement(0, [
        { name: 1, value: 3 },
        { name: 2, value: 4 },
      ]),
      endElement(0),
    );

  it("decodes multibyte text and two-byte length prefixes", () => {
    expect(readAndroidManifest(utf8Doc())).toMatchObject({
      ok: true,
      value: { package: "dev.rea.ação", split: LONG_SPLIT },
    });
  });

  it("never throws for arbitrary single-byte corruption", () => {
    const original = utf8Doc();
    for (let index = 0; index < original.length; index += 1) {
      const bytes = Uint8Array.from(original);
      bytes[index] = bytes[index]! ^ 0xff;
      expect(() => readAndroidManifest(bytes)).not.toThrow();
    }
  });
});

describe("readAndroidManifest (malformed input)", () => {
  it("rejects an empty document as truncated", () => {
    expect(readAndroidManifest(new Uint8Array())).toMatchObject({
      ok: false,
      error: { kind: "truncated" },
    });
  });

  it("rejects a non-XML chunk type as malformed", () => {
    const bytes = Uint8Array.from(valid());
    bytes[0] = 0x01;
    expect(readAndroidManifest(bytes)).toMatchObject({
      ok: false,
      error: { kind: "malformed" },
    });
  });

  it("reports a document cut short as truncated", () => {
    const bytes = valid();
    expect(
      readAndroidManifest(bytes.subarray(0, bytes.length - 12)),
    ).toMatchObject({ ok: false, error: { kind: "truncated" } });
  });

  it("refuses a string pool declaring an unbounded string count", () => {
    const bytes = Uint8Array.from(valid());
    // stringCount sits at pool chunk offset 8, after the 8-byte document header.
    new DataView(bytes.buffer).setUint32(8 + 8, 0x7fffffff, true);
    expect(readAndroidManifest(bytes)).toMatchObject({
      ok: false,
      error: { kind: "limit_exceeded" },
    });
  });

  it("refuses documents above the size cap before walking them", () => {
    expect(
      readAndroidManifest(new Uint8Array(MAX_MANIFEST_BYTES + 1)),
    ).toMatchObject({ ok: false, error: { kind: "limit_exceeded" } });
  });

  it("never throws for arbitrary single-byte corruption", () => {
    const original = valid();
    for (let index = 0; index < original.length; index += 1) {
      const bytes = Uint8Array.from(original);
      bytes[index] = bytes[index]! ^ 0xff;
      expect(() => readAndroidManifest(bytes)).not.toThrow();
    }
  });
});

describe("readAndroidManifest (hostile structure)", () => {
  it("does not decode a shared giant string once per offset", () => {
    // One 4 Mi-character string referenced by 100,000 pool entries. Eager
    // decoding would copy ~800 GiB; the reader must only touch strings it uses.
    const repeats = Array.from({ length: 99_998 }, () => 1);
    const bytes = document(
      stringPool(["manifest", giantString(4 * 1024 * 1024)], repeats),
      startElement(0, []),
      endElement(0),
    );
    // Completion is the assertion: eager decoding exhausts memory instead.
    expect(readAndroidManifest(bytes).ok).toBe(true);
  });

  it("refuses a START_ELEMENT whose attributes would lie outside its chunk", () => {
    // The element holds no attributes, but attributeStart skips the next
    // chunk's 8-byte header so one declared attribute would be read from that
    // foreign chunk's payload, shaped like `package="dev.rea"`.
    const bytes = document(
      stringPool(["manifest", "package", "dev.rea"]),
      startElement(0, [], 1, 20 + 8),
      foreignChunkCarryingAttribute({ name: 1, value: 2 }),
      endElement(0),
    );
    expect(readAndroidManifest(bytes)).toMatchObject({
      ok: false,
      error: { kind: "malformed" },
    });
  });

  it("reads a minimal hand-built manifest", () => {
    const bytes = document(
      stringPool(["manifest", "package", "dev.rea"]),
      startElement(0, [{ name: 1, value: 2 }]),
      endElement(0),
    );
    expect(readAndroidManifest(bytes)).toMatchObject({
      ok: true,
      value: { package: "dev.rea" },
    });
  });

  it("refuses an element name index outside the pool", () => {
    const bytes = document(
      stringPool(["manifest"]),
      startElement(9, []),
      endElement(0),
    );
    expect(readAndroidManifest(bytes)).toMatchObject({
      ok: false,
      error: { kind: "malformed" },
    });
  });
});

describe("readAndroidManifest (element balance)", () => {
  const pool = stringPool(["manifest", "application"]);
  const malformed = { ok: false, error: { kind: "malformed" } };

  it("refuses an end element that closes the wrong element", () => {
    const bytes = document(
      pool,
      startElement(0, []),
      startElement(1, []),
      endElement(0),
      endElement(1),
    );
    expect(readAndroidManifest(bytes)).toMatchObject(malformed);
  });

  it("refuses an end element with nothing open", () => {
    const bytes = document(
      pool,
      startElement(0, []),
      endElement(0),
      endElement(0),
    );
    expect(readAndroidManifest(bytes)).toMatchObject(malformed);
  });

  it("refuses a manifest that is never closed", () => {
    const bytes = document(pool, startElement(0, []));
    expect(readAndroidManifest(bytes)).toMatchObject(malformed);
  });

  it("refuses a second root element", () => {
    const bytes = document(
      pool,
      startElement(0, []),
      endElement(0),
      startElement(0, []),
      endElement(0),
    );
    expect(readAndroidManifest(bytes)).toMatchObject(malformed);
  });

  it("refuses a string pool whose data overlaps its offset table", () => {
    const bytes = Uint8Array.from(
      document(pool, startElement(0, []), endElement(0)),
    );
    // stringsStart sits at pool chunk offset 20, after the 8-byte document header.
    new DataView(bytes.buffer).setUint32(8 + 20, 4, true);
    expect(readAndroidManifest(bytes)).toMatchObject(malformed);
  });
});

describe("readAndroidManifest (declared but unusable values)", () => {
  const ANDROID_NS = "http://schemas.android.com/apk/res/android";
  const build = (...attributes: Parameters<typeof startElement>[1]): Buffer =>
    document(
      stringPool([
        "manifest",
        "package",
        "split",
        "versionCode",
        "constructor",
        "toString",
        ANDROID_NS,
        "dev.rea",
      ]),
      startElement(0, attributes),
      endElement(0),
    );

  it("reports a package declared as an integer as unresolved", () => {
    const result = readAndroidManifest(
      build({ name: 1, value: 42, type: "int" }),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { package: null, unresolved_attributes: ["manifest@package"] },
    });
  });

  it("reports a split declared as a reference as unresolved", () => {
    const result = readAndroidManifest(
      build({ name: 2, value: 0x7f010001, type: "reference" }),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { split: null, unresolved_attributes: ["manifest@split"] },
    });
  });

  it("reports a versionCode declared as a string as unresolved", () => {
    const result = readAndroidManifest(
      build({ namespace: 6, name: 3, value: 7 }),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        version_code: null,
        unresolved_attributes: ["manifest@versionCode"],
      },
    });
  });

  it("ignores attribute names that exist on Object.prototype", () => {
    const result = readAndroidManifest(
      build(
        { name: 4, value: 7 },
        { namespace: 6, name: 5, value: 7 },
        { name: 1, value: 7 },
      ),
    );
    expect(result).toMatchObject({ ok: true, value: { package: "dev.rea" } });
    if (!result.ok) throw new Error("expected a manifest");
    expect(Object.keys(result.value).sort()).toEqual(
      [
        "config_for_split",
        "is_feature_split",
        "is_split_required",
        "isolated_splits",
        "min_sdk_version",
        "package",
        "split",
        "target_sandbox_version",
        "target_sdk_version",
        "unresolved_attributes",
        "version_code",
        "version_code_major",
        "version_name",
      ].sort(),
    );
  });
});

describe("readAndroidManifest (review follow-ups)", () => {
  const ANDROID_NS = "http://schemas.android.com/apk/res/android";

  it("reports a renamed attribute under its recognized name", () => {
    const ids = Buffer.alloc(8);
    ids.writeUInt32LE(0x0101055b, 4); // isFeatureSplit, for name index 1
    const result = readAndroidManifest(
      document(
        stringPool(["manifest", "a", ANDROID_NS]),
        chunk(0x0180, Buffer.alloc(0), ids),
        startElement(0, [
          { namespace: 2, name: 1, value: 0x7f010001, type: "reference" },
        ]),
        endElement(0),
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        is_feature_split: null,
        unresolved_attributes: ["manifest@isFeatureSplit"],
      },
    });
  });

  it("refuses a second string pool instead of resetting the decode budget", () => {
    const result = readAndroidManifest(
      document(
        stringPool(STRINGS),
        stringPool(STRINGS),
        startElement(0, [{ name: 1, value: 4 }]),
        endElement(0),
      ),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "malformed" } });
  });

  it("refuses invalid UTF-8 instead of replacing it", () => {
    const bytes = Buffer.from(
      document(
        stringPool(STRINGS, [], "utf8"),
        startElement(0, [{ name: 1, value: 4 }]),
        endElement(0),
      ),
    );
    const at = bytes.indexOf("dev.rea");
    expect(at).toBeGreaterThan(0);
    bytes[at] = 0xff;
    expect(readAndroidManifest(bytes)).toMatchObject({
      ok: false,
      error: { kind: "malformed" },
    });
  });
});
