import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildBinary } from "plist";
import { expect, it, vi } from "vitest";

import { analyzeInterfaceBuilderBundle } from "./InterfaceBuilderAnalysis.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";

const { stackOverflow } = vi.hoisted(() => ({
  stackOverflow: (): never => {
    throw new RangeError("Maximum call stack size exceeded");
  },
}));

// A host stack limit says nothing about the archive bytes, whichever decoder
// reached it.
vi.mock("../../domain/propertyListKeys.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  parseXmlPropertyList: stackOverflow,
}));
vi.mock(
  "../../domain/apple/binaryPlistMaterializer.js",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    decodeBinaryPropertyList: stackOverflow,
  }),
);

it.each([
  ["XML", Buffer.from('<?xml version="1.0"?><plist><dict/></plist>')],
  ["binary", Buffer.from(buildBinary({}))],
] as const)(
  "omits a %s archive that reached a host stack limit instead of calling it invalid",
  async (_format, bytes) => {
    const root = await createTestTempDirectory("rea-ib-host-limit-");
    const bundle = join(root, "Example.app");
    await mkdir(bundle);
    await writeFile(join(bundle, "Deep.nib"), bytes);

    const result = await analyzeInterfaceBuilderBundle({
      bundlePath: bundle,
      targetSha256: "a".repeat(64),
    });

    expect(result.documents).toEqual([]);
    expect(result.graph.coverage).toContainEqual(
      expect.objectContaining({
        facet: "archive_decode",
        status: "partial",
        reason: "aggregate_decode_budget_exhausted",
        omitted: 1,
      }),
    );
    expect(result.limitations).toContain(
      "Deep.nib: omitted because aggregate decode budget exhausted.",
    );
  },
);
