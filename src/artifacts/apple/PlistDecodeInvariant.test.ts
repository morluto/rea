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
import { parsePlistBinary } from "../../native/parsers/plist.js";
import { ArtifactProvider } from "../ArtifactProvider.js";
import { DeferredAnalysisClient } from "../../providers/DeferredAnalysisClient.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";

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

const archive = Buffer.from(
  buildBinary({
    $archiver: "NSKeyedArchiver",
    $version: 100000,
    $objects: ["$null", "leaf"],
    $top: { root: { CF$UID: 1 } },
  }),
);

it("rethrows an invariant violation instead of reporting plist output", () => {
  const bytes = Buffer.from(buildBinary({ CFBundleIdentifier: "example" }));
  expect(parsePlistBinary(bytes).ok).toBe(true);

  decoder.broken = true;
  expect(() => parsePlistBinary(bytes)).toThrow(InternalInvariantError);
});

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

it.each([
  ["inspect_keyed_archive", { path: "Model.plist" }],
  ["decode_interface_builder", {}],
] as const)(
  "reports an invariant violation in %s as an adapter failure, not an artifact read",
  async (operation, parameters) => {
    const bundle = await createTestTempDirectory("rea-artifact-invariant-");
    const infoPlist = join(bundle, "Info.plist");
    await writeFile(infoPlist, '<?xml version="1.0"?><plist><dict/></plist>');
    await writeFile(join(bundle, "Model.plist"), archive);
    await writeFile(join(bundle, "Panel.nib"), archive);
    const provider = new ArtifactProvider({}, "darwin");
    // The deferred client is the adapter boundary every composed provider uses.
    const client = new DeferredAnalysisClient(
      () =>
        Promise.resolve(
          provider.createBundleResourceClient({
            callerPath: bundle,
            canonicalPath: bundle,
            infoPlistPath: infoPlist,
            layout: "root",
            executableSha256: null,
          }),
        ),
      provider.identity().id,
    );
    try {
      expect((await client.execute(operation, parameters)).ok).toBe(true);

      decoder.broken = true;
      const result = await client.execute(operation, parameters);
      if (result.ok)
        throw new Error("Expected the defect to fail the operation");
      expect(result.error).toBeInstanceOf(ProviderAdapterError);
      expect(result.error.cause).toBeInstanceOf(InternalInvariantError);
    } finally {
      await client.close();
    }
  },
);
