import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildBinary } from "plist";
import { afterEach, expect, it, vi } from "vitest";

import {
  InternalInvariantError,
  invariantViolation,
} from "../domain/internalInvariant.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ReleaseExposureReader } from "./ReleaseExposureReader.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

/**
 * No input reaches an invariant site today, so the binary plist text decoder
 * is replaced with one that reports a broken internal assumption.
 */
const decoder = vi.hoisted(() => ({ broken: false }));

vi.mock("./apple/BinaryPlistMaterializer.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./apple/BinaryPlistMaterializer.js")>();
  return {
    ...actual,
    decodeBinaryPlistText: (
      ...args: Parameters<typeof actual.decodeBinaryPlistText>
    ) => {
      if (decoder.broken)
        throw invariantViolation("binary plist decoder copy lost its trailer");
      return actual.decodeBinaryPlistText(...args);
    },
  };
});

afterEach(() => {
  decoder.broken = false;
});

const scan = async (path: string) => {
  const reader = new ReleaseExposureReader();
  try {
    const result = await reader.inspect({ path }, undefined, () => undefined);
    if (!result.ok) throw result.error;
    return result.value.text_members;
  } finally {
    await reader.close();
  }
};

it("rethrows an invariant violation instead of scanning the plist's raw bytes", async () => {
  const root = await createTestTempDirectory("rea-release-exposure-invariant-");
  await writeFile(
    join(root, "Info.plist"),
    Buffer.from(buildBinary({ CFBundleIdentifier: "example" })),
  );
  expect(await scan(root)).toEqual({ scanned: 1, skipped: 0 });

  decoder.broken = true;
  const rejected = await scan(root).catch((cause: unknown) => cause);

  // The workflow reports the defect as an adapter failure, not a scanned member.
  expect(rejected).toBeInstanceOf(ProviderAdapterError);
  expect((rejected as ProviderAdapterError).cause).toBeInstanceOf(
    InternalInvariantError,
  );
});
