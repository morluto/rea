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
