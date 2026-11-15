import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildBinary } from "plist";
import { afterEach, expect, it, vi } from "vitest";

import {
  InternalInvariantError,
  invariantViolation,
} from "../../domain/internalInvariant.js";
import { analyzeInterfaceBuilderBundle } from "./InterfaceBuilderAnalysis.js";
import { inspectBundleKeyedArchive } from "./KeyedArchiveReader.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";

/**
 * No input reaches an invariant site today, so the shared binary plist
 * decoder is replaced with one that reports a broken internal assumption.
 */
const decoder = vi.hoisted(() => ({ broken: false }));

vi.mock("./BinaryPlistMaterializer.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./BinaryPlistMaterializer.js")>();
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
});

afterEach(() => {
  decoder.broken = false;
});

const archive = Buffer.from(
  buildBinary({
    $archiver: "NSKeyedArchiver",
    $version: 100000,
    $objects: ["$null", "leaf"],
    $top: { root: { CF$UID: 1 } },
  }),
);

it("rethrows an invariant violation instead of reporting a damaged keyed archive", async () => {
  const root = await createTestTempDirectory("rea-keyed-invariant-");
  await mkdir(join(root, "Contents", "Resources"), { recursive: true });
  await writeFile(join(root, "Contents", "Resources", "Model.plist"), archive);
  const inspect = () =>
    inspectBundleKeyedArchive({
      bundlePath: root,
      targetSha256: "a".repeat(64),
      parameters: { path: "Contents/Resources/Model.plist" },
      platform: "darwin",
    });
  await expect(inspect()).resolves.toBeDefined();

  decoder.broken = true;
  const rejected = await inspect().catch((cause: unknown) => cause);

  expect(rejected).toBeInstanceOf(InternalInvariantError);
});

it("rethrows an invariant violation instead of listing an invalid Interface Builder archive", async () => {
  const root = await createTestTempDirectory("rea-ib-invariant-");
  const bundle = join(root, "Example.app");
  await mkdir(bundle);
  await writeFile(join(bundle, "Panel.nib"), archive);
  const analyze = () =>
    analyzeInterfaceBuilderBundle({
      bundlePath: bundle,
      targetSha256: "a".repeat(64),
    });
  expect((await analyze()).documents).toHaveLength(1);

  decoder.broken = true;
  const rejected = await analyze().catch((cause: unknown) => cause);

  expect(rejected).toBeInstanceOf(InternalInvariantError);
});
