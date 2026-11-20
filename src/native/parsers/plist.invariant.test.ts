import { buildBinary } from "plist";
import { afterEach, expect, it, vi } from "vitest";

import {
  InternalInvariantError,
  invariantViolation,
} from "../../domain/internalInvariant.js";
import { parsePlistBinary } from "./plist.js";

/**
 * No input reaches an invariant site today, so the shared binary plist
 * decoder is replaced with one that reports a broken internal assumption.
 */
const decoder = vi.hoisted(() => ({ broken: false }));

vi.mock(
  "../../domain/apple/binaryPlistMaterializer.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../domain/apple/binaryPlistMaterializer.js")
      >();
    return {
      ...actual,
      decodeBinaryPropertyList: (
        ...args: Parameters<typeof actual.decodeBinaryPropertyList>
      ) => {
        if (decoder.broken)
          throw invariantViolation("Binary plist source plan is missing");
        return actual.decodeBinaryPropertyList(...args);
      },
    };
  },
);

afterEach(() => {
  decoder.broken = false;
});

it("rethrows an invariant violation instead of reporting plist output", () => {
  const bytes = Buffer.from(buildBinary({ CFBundleIdentifier: "example" }));
  expect(parsePlistBinary(bytes).ok).toBe(true);

  decoder.broken = true;
  expect(() => parsePlistBinary(bytes)).toThrow(InternalInvariantError);
});
