import { expect, it } from "vitest";
import { readAndroidManifestSplitTypes } from "./AndroidManifestSplitTypes.js";
import { axmlManifestBytes } from "../../tests/fixtures/android/axmlManifest.js";

it("reads required split types and isSplitRequired from a binary manifest", () => {
  expect(
    readAndroidManifestSplitTypes(
      axmlManifestBytes({
        requiredSplitTypes: "base__abi,base__density",
        splitRequired: true,
      }),
    ),
  ).toEqual({
    requiredSplitTypes: ["base__abi", "base__density"],
    splitRequired: true,
  });
});

it("reads required split types from a UTF-16 string pool", () => {
  expect(
    readAndroidManifestSplitTypes(
      axmlManifestBytes({
        utf16: true,
        requiredSplitTypes: "base__abi",
      }),
    ),
  ).toEqual({ requiredSplitTypes: ["base__abi"], splitRequired: false });
});

it("reads isSplitRequired alone when no split types are named", () => {
  expect(
    readAndroidManifestSplitTypes(
      axmlManifestBytes({ splitRequired: true }),
    ),
  ).toEqual({ requiredSplitTypes: [], splitRequired: true });
});

it("reports no splits for a manifest without split attributes", () => {
  expect(readAndroidManifestSplitTypes(axmlManifestBytes())).toEqual({
    requiredSplitTypes: [],
    splitRequired: false,
  });
});

it("returns null for text XML, truncated bytes and a non-manifest root", () => {
  expect(
    readAndroidManifestSplitTypes(
      Buffer.from('<manifest package="fixture"/>', "utf8"),
    ),
  ).toBeNull();
  const truncated = axmlManifestBytes({
    requiredSplitTypes: "base__abi",
  });
  expect(
    readAndroidManifestSplitTypes(truncated.subarray(0, truncated.length - 4)),
  ).toBeNull();
  expect(
    readAndroidManifestSplitTypes(
      axmlManifestBytes({ rootName: "other", requiredSplitTypes: "base__abi" }),
    ),
  ).toBeNull();
  expect(readAndroidManifestSplitTypes(Buffer.from([]))).toBeNull();
});
