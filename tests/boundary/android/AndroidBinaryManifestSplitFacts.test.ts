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
      required_split_types: ["base__abi", "base__density"],
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
  expect(facts.ok && facts.value.required_split_types).toEqual(["base__abi"]);
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
  expect(readAndroidBinaryManifestSplitFacts(bytes)).toMatchObject({
    ok: false,
    error: { kind: "malformed" },
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
    ok: false,
    error: { kind: "malformed" },
  });
});
