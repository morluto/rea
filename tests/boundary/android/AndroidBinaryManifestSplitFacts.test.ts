import { expect, it } from "vitest";
import {
  ANDROID_NS,
  binaryManifestFixture,
  type BinaryManifestAttributeInput,
} from "../../fixtures/android/binaryManifest.js";
import { readAndroidBinaryManifestSplitFacts } from "../../../src/android/AndroidBinaryManifestSplitFacts.js";

const android = (
  name: string,
  changes: Partial<BinaryManifestAttributeInput> = {},
): BinaryManifestAttributeInput => ({
  namespace: ANDROID_NS,
  name,
  ...changes,
});

it("reads required split types from the binary <manifest> element", () => {
  const facts = readAndroidBinaryManifestSplitFacts(
    binaryManifestFixture({
      attributes: [
        android("requiredSplitTypes", {
          resourceId: 0x0101064c,
          stringValue: "base__abi,base__density",
        }),
      ],
    }),
  );
  expect(facts).toEqual({
    ok: true,
    value: {
      required_split_types: {
        types: ["base__abi", "base__density"],
        declared_count: 2,
        truncated: false,
      },
      split_name: null,
      is_split_required: null,
    },
  });
});

it("finds a split attribute by its resource ID rather than its name", () => {
  // The fixture writes the resource map at the string-pool index of each name,
  // so this resolves through resourceIds[nameIndex]. A renamed attribute keeps
  // the framework ID and must still be read.
  const facts = readAndroidBinaryManifestSplitFacts(
    binaryManifestFixture({
      attributes: [
        android("requiredSplitTypesV2", {
          resourceId: 0x0101064c,
          stringValue: "base__abi",
        }),
      ],
    }),
  );
  expect(facts.ok && facts.value.required_split_types).toMatchObject({
    types: ["base__abi"],
    declared_count: 1,
    truncated: false,
  });
});

it("bounds retained split types and reports the declaration's full count", () => {
  // A near-1 MiB literal of short comma-separated values is one string-pool
  // entry, so nothing earlier bounds how many tokens it can retain. Keep a
  // fixed prefix and report the count the declaration states.
  const declared = Array.from({ length: 200 }, (_, index) => `part${String(index)}`);
  const facts = readAndroidBinaryManifestSplitFacts(
    binaryManifestFixture({
      attributes: [
        android("requiredSplitTypes", {
          resourceId: 0x0101064c,
          stringValue: declared.join(","),
        }),
      ],
    }),
  );
  expect(facts.ok && facts.value.required_split_types).toMatchObject({
    types: declared.slice(0, 64),
    declared_count: 200,
    truncated: true,
  });
});

it("reads an isSplitRequired boolean and ignores non-Android namespaces", () => {
  const facts = readAndroidBinaryManifestSplitFacts(
    binaryManifestFixture({
      attributes: [
        {
          namespace: "http://example.com/other",
          name: "isSplitRequired",
          booleanValue: true,
        },
        android("isSplitRequired", {
          resourceId: 0x0101064d,
          booleanValue: true,
        }),
      ],
    }),
  );
  expect(facts.ok && facts.value.is_split_required).toBe(true);
  expect(facts.ok && facts.value.required_split_types).toBeNull();
});

it("reports a manifest with no split declarations as having none", () => {
  const facts = readAndroidBinaryManifestSplitFacts(
    binaryManifestFixture({
      attributes: [
        android("versionName", { resourceId: 0x0101021c, stringValue: "1.0" }),
      ],
    }),
  );
  expect(facts.ok && facts.value).toEqual({
    required_split_types: null,
    split_name: null,
    is_split_required: null,
  });
});

it("rejects a plain-text or truncated manifest without claiming split facts", () => {
  expect(
    readAndroidBinaryManifestSplitFacts(Buffer.from("<manifest/>")),
  ).toMatchObject({ ok: false, error: { kind: "unsupported" } });
  const bytes = binaryManifestFixture({
    attributes: [android("isSplitRequired", { booleanValue: true })],
  });
  expect(
    readAndroidBinaryManifestSplitFacts(bytes.subarray(0, 12)),
  ).toMatchObject({ ok: false });
});

it("treats a chunk that leaves the document as malformed", () => {
  const bytes = Buffer.from(
    binaryManifestFixture({
      attributes: [android("isSplitRequired", { booleanValue: true })],
    }),
  );
  bytes.writeUInt32LE(0x7fffffff, 4);
  expect(readAndroidBinaryManifestSplitFacts(bytes)).toMatchObject({
    ok: false,
    error: { kind: "malformed" },
  });
});

it("treats an undersized start-element header as unreadable rather than empty", () => {
  // ResXMLTree_node is 16 bytes; advertising 12 shifts the attribute table by
  // four bytes, so the split declarations read as absent instead of failing.
  const bytes = Buffer.from(
    binaryManifestFixture({
      attributes: [
        android("requiredSplitTypes", {
          resourceId: 0x0101064c,
          stringValue: "base__abi",
        }),
      ],
    }),
  );
  const starts: number[] = [];
  for (let at = 8; at + 8 <= bytes.length; at++) {
    if (bytes.readUInt16LE(at) === 0x0102 && bytes.readUInt16LE(at + 2) === 16)
      starts.push(at);
  }
  expect(starts).toHaveLength(1);
  bytes.writeUInt16LE(12, starts[0]! + 2);
  // The root is unreadable, so its declarations are unknown rather than absent;
  // the document is still an admitted binary manifest.
  expect(readAndroidBinaryManifestSplitFacts(bytes)).toMatchObject({
    ok: true,
    value: { required_split_types: "unknown", is_split_required: "unknown" },
  });
});

it("reports a resource-reference isSplitRequired as unknown rather than absent", () => {
  // `android:isSplitRequired="@bool/split_required"` is carried as a typed
  // reference; it has no literal to read and can resolve to true at install.
  const facts = readAndroidBinaryManifestSplitFacts(
    binaryManifestFixture({
      attributes: [
        android("isSplitRequired", {
          resourceId: 0x0101064d,
          typedValue: { dataType: 0x01, data: 0x7f050001 },
        }),
      ],
    }),
  );
  expect(facts.ok && facts.value.is_split_required).toBe("unknown");
});

it("reports resource-referenced split types as unknown rather than absent", () => {
  const facts = readAndroidBinaryManifestSplitFacts(
    binaryManifestFixture({
      attributes: [
        android("requiredSplitTypes", {
          resourceId: 0x0101064c,
          typedValue: { dataType: 0x01, data: 0x7f050002 },
        }),
      ],
    }),
  );
  expect(facts.ok && facts.value.required_split_types).toBe("unknown");
});

it("treats an attribute table that starts inside the node extension as malformed", () => {
  // attributeStart below ResXMLTree_attrExt points the table into the
  // extension: the root still decodes as `manifest` and the declaration is
  // silently skipped.
  const bytes = Buffer.from(
    binaryManifestFixture({
      attributes: [
        android("requiredSplitTypes", {
          resourceId: 0x0101064c,
          stringValue: "base__abi",
        }),
      ],
    }),
  );
  const starts: number[] = [];
  for (let at = 8; at + 8 <= bytes.length; at++) {
    if (bytes.readUInt16LE(at) === 0x0102 && bytes.readUInt16LE(at + 2) === 16)
      starts.push(at);
  }
  expect(starts).toHaveLength(1);
  bytes.writeUInt16LE(0, starts[0]! + 24);
  expect(readAndroidBinaryManifestSplitFacts(bytes)).toMatchObject({
    ok: true,
    value: { required_split_types: "unknown", is_split_required: "unknown" },
  });
});

it("rejects a resource map whose payload ends inside a resource ID", () => {
  // The map is a flat run of 4-byte IDs indexed by string-pool slot; a payload
  // ending mid-word would shift every later slot and read a framework attribute
  // as absent, so the document is malformed rather than silently truncated.
  const bytes = Buffer.from(
    binaryManifestFixture({
      attributes: [
        android("requiredSplitTypesV2", {
          resourceId: 0x0101064c,
          stringValue: "base__abi",
        }),
      ],
    }),
  );
  const map = bytes.indexOf(Buffer.from([0x80, 0x01, 0x08, 0x00]));
  expect(map).toBeGreaterThan(0);
  // Slice two bytes off the map's only ID and pull the following chunks up by
  // the same amount, so the walk still lands exactly on the declared size and
  // the map is the only thing left partial.
  const mapSize = bytes.readUInt32LE(map + 4);
  expect(mapSize % 4).toBe(0);
  bytes.copyWithin(map + mapSize - 2, map + mapSize);
  const trimmed = bytes.subarray(0, bytes.length - 2);
  trimmed.writeUInt32LE(mapSize - 2, map + 4);
  trimmed.writeUInt32LE(trimmed.length, 4);
  expect(readAndroidBinaryManifestSplitFacts(trimmed)).toMatchObject({
    ok: false,
    error: { kind: "malformed" },
  });
});

it("reads an isSplitRequired declared on the <application> element", () => {
  // Bundle-generated base APKs put the flag on <application>; reading only the
  // root would report complete coverage for libraries that live in a split.
  const facts = readAndroidBinaryManifestSplitFacts(
    binaryManifestFixture({
      attributes: [],
      application: [
        android("isSplitRequired", {
          resourceId: 0x0101064d,
          booleanValue: true,
        }),
      ],
    }),
  );
  expect(facts.ok && facts.value.is_split_required).toBe(true);
  expect(facts.ok && facts.value.required_split_types).toBeNull();
});

it("reports an unreadable <application> element as unknown rather than absent", () => {
  // The <application> element is where a bundle-generated base APK carries
  // isSplitRequired, so a malformed one must not read as a plain absence.
  const bytes = Buffer.from(
    binaryManifestFixture({
      attributes: [],
      application: [
        android("isSplitRequired", {
          resourceId: 0x0101064d,
          booleanValue: true,
        }),
      ],
    }),
  );
  // Rewrite the application start element's header size below the 16-byte
  // ResXMLTree_node, which makes readStartElement return null. The root and
  // the application share the same chunk type and header size prefix, so this
  // takes the second occurrence.
  const startElement = Buffer.from([0x02, 0x01, 0x10, 0x00]);
  const root = bytes.indexOf(startElement, 8);
  const application = bytes.indexOf(startElement, root + 1);
  expect(application).toBeGreaterThan(0);
  bytes.writeUInt16LE(12, application + 2);
  expect(readAndroidBinaryManifestSplitFacts(bytes)).toMatchObject({
    ok: true,
    value: { is_split_required: "unknown" },
  });
});

it("rejects a chunk whose header exceeds its own size", () => {
  // An oversized resource-map header consumes the whole chunk, leaving no IDs,
  // so a split attribute identified only by its framework ID reads as absent.
  const bytes = Buffer.from(
    binaryManifestFixture({
      attributes: [
        android("requiredSplitTypes", {
          resourceId: 0x0101064c,
          stringValue: "base__abi",
        }),
      ],
    }),
  );
  const map = bytes.indexOf(Buffer.from([0x80, 0x01, 0x08, 0x00]));
  expect(map).toBeGreaterThan(0);
  bytes.writeUInt16LE(0x2000, map + 2);
  expect(readAndroidBinaryManifestSplitFacts(bytes)).toMatchObject({
    ok: false,
    error: { kind: "malformed" },
  });
});

it("rejects a document whose trailing bytes are a truncated chunk header", () => {
  // A declared size larger than the last whole chunk would otherwise end the
  // walk early and report the split declarations as absent.
  const bytes = Buffer.from(
    binaryManifestFixture({
      attributes: [
        android("requiredSplitTypes", {
          resourceId: 0x0101064c,
          stringValue: "base__abi",
        }),
      ],
    }),
  );
  const padded = Buffer.concat([bytes, Buffer.alloc(4)]);
  padded.writeUInt32LE(padded.length, 4);
  expect(readAndroidBinaryManifestSplitFacts(padded)).toMatchObject({
    ok: false,
    error: { kind: "malformed" },
  });
});

it("rejects a start element whose chunk cannot hold its attribute extension", () => {
  // The node header is intact but chunkSize stops before ResXMLTree_attrExt,
  // so the reads would come from bytes outside the element.
  const bytes = Buffer.from(
    binaryManifestFixture({
      attributes: [
        android("requiredSplitTypes", {
          resourceId: 0x0101064c,
          stringValue: "base__abi",
        }),
      ],
    }),
  );
  const starts: number[] = [];
  for (let at = 8; at + 8 <= bytes.length; at++)
    if (bytes.readUInt16LE(at) === 0x0102 && bytes.readUInt16LE(at + 2) === 16)
      starts.push(at);
  expect(starts).toHaveLength(1);
  bytes.writeUInt32LE(24, starts[0]! + 4);
  expect(readAndroidBinaryManifestSplitFacts(bytes)).toMatchObject({
    ok: false,
    error: { kind: "malformed" },
  });
});

it("finds a split attribute by its framework ID outside a bound namespace", () => {
  // The canonical ID identifies the attribute even when its spelling places it
  // outside the Android namespace; only the name fallback needs that namespace.
  const facts = readAndroidBinaryManifestSplitFacts(
    binaryManifestFixture({
      attributes: [
        android("x", {
          namespace: "urn:obfuscated",
          resourceId: 0x0101064d,
          booleanValue: true,
        }),
      ],
    }),
  );
  expect(facts.ok && facts.value.is_split_required).toBe(true);
});

it("rejects a start element whose header size is not the 16-byte node header", () => {
  // attrExt is read at fixed offsets from the node, so a padded header would
  // decode the root but read a real isSplitRequired row four bytes late.
  const bytes = Buffer.from(
    binaryManifestFixture({
      attributes: [
        android("isSplitRequired", {
          resourceId: 0x0101064d,
          booleanValue: true,
        }),
      ],
    }),
  );
  const starts: number[] = [];
  for (let at = 8; at + 8 <= bytes.length; at++)
    if (bytes.readUInt16LE(at) === 0x0102 && bytes.readUInt16LE(at + 2) === 16)
      starts.push(at);
  expect(starts).toHaveLength(1);
  bytes.writeUInt16LE(20, starts[0]! + 2);
  expect(readAndroidBinaryManifestSplitFacts(bytes)).toMatchObject({
    ok: true,
    value: { is_split_required: "unknown" },
  });
});

it("reports an unreadable element name as unknown rather than absent", () => {
  // A name string index outside the pool leaves the element with no name, so
  // the split flag it carries cannot be read but must not read as absent.
  const bytes = Buffer.from(
    binaryManifestFixture({
      attributes: [],
      application: [
        android("isSplitRequired", {
          resourceId: 0x0101064d,
          booleanValue: true,
        }),
      ],
    }),
  );
  const startElement = Buffer.from([0x02, 0x01, 0x10, 0x00]);
  const root = bytes.indexOf(startElement, 8);
  const application = bytes.indexOf(startElement, root + 1);
  expect(application).toBeGreaterThan(0);
  // attrExt.name sits 20 bytes into the node.
  bytes.writeUInt32LE(0xffff, application + 20);
  expect(readAndroidBinaryManifestSplitFacts(bytes)).toMatchObject({
    ok: true,
    value: { is_split_required: "unknown" },
  });
});

it("treats a repeated root's declarations as ambiguous instead of last-one-wins", () => {
  // A second, attribute-less <manifest> would otherwise replace the first and
  // the required split types would read as absent, leaving JNI coverage
  // looking complete while the split libraries are unaccounted for.
  const facts = readAndroidBinaryManifestSplitFacts(
    binaryManifestFixture({
      attributes: [
        android("requiredSplitTypes", {
          resourceId: 0x0101064c,
          stringValue: "base__abi",
        }),
        android("isSplitRequired", {
          resourceId: 0x0101064d,
          booleanValue: true,
        }),
      ],
      repeatedRootAttributes: [],
    }),
  );
  expect(facts).toEqual({
    ok: true,
    value: {
      required_split_types: "unknown",
      split_name: null,
      is_split_required: "unknown",
    },
  });
});

it("treats a duplicated split attribute as ambiguous instead of first-one-wins", () => {
  // The same framework attribute declared twice leaves no single row
  // authoritative; keeping the first would report complete JNI coverage from a
  // value a later declaration contradicts.
  const facts = readAndroidBinaryManifestSplitFacts(
    binaryManifestFixture({
      attributes: [
        android("isSplitRequired", {
          resourceId: 0x0101064d,
          booleanValue: false,
        }),
        android("isSplitRequired", {
          resourceId: 0x0101064d,
          booleanValue: true,
        }),
        android("requiredSplitTypes", {
          resourceId: 0x0101064c,
          stringValue: "base__abi",
        }),
        android("requiredSplitTypes", {
          resourceId: 0x0101064c,
          stringValue: "base__abi,base__density",
        }),
      ],
    }),
  );
  expect(facts).toEqual({
    ok: true,
    value: {
      required_split_types: "unknown",
      split_name: null,
      is_split_required: "unknown",
    },
  });
});

it("decodes a UTF-16 string whose length needs the two-word prefix", () => {
  // ResStringPool stores a length of 0x8000 or more as two words, so the
  // string data starts after the continuation word. Reading only the first
  // word would slice from inside that word and return a truncated literal as
  // if it were complete.
  const declared = Array.from(
    { length: 4096 },
    (_, index) => `part${String(index)}`,
  ).join(",");
  expect(declared.length).toBeGreaterThanOrEqual(0x8000);
  const facts = readAndroidBinaryManifestSplitFacts(
    binaryManifestFixture({
      attributes: [
        android("requiredSplitTypes", {
          resourceId: 0x0101064c,
          stringValue: declared,
        }),
      ],
    }),
  );
  expect(facts.ok && facts.value.required_split_types).toMatchObject({
    types: declared.split(",").slice(0, 64),
    declared_count: 4096,
    truncated: true,
  });
});
