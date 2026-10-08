import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { build } from "plist";
import { expect, it } from "vitest";

import { analyzeInterfaceBuilderBundle } from "../../../src/artifacts/apple/InterfaceBuilderAnalysis.js";
import { inspectBundleKeyedArchive } from "../../../src/artifacts/apple/KeyedArchiveReader.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const archive = build({
  $archiver: "NSKeyedArchiver",
  $objects: ["$null", "Café"],
  $top: { root: { CF$UID: 1 } },
});

const fixture = async (declaration: string) => {
  const bundlePath = await createTestTempDirectory("rea-xml-declaration-");
  await writeFile(
    join(bundlePath, "Panel.nib"),
    Buffer.from(archive.replace("UTF-8", declaration), "utf8"),
  );
  return { bundlePath, targetSha256: "a".repeat(64) };
};

it.each(["UTF-8", "utf-8"])(
  "retains UTF-8 characters with the supported declaration %s",
  async (declaration) => {
    const input = await fixture(declaration);
    const archiveResult = await inspectBundleKeyedArchive({
      ...input,
      parameters: { path: "Panel.nib" },
    });
    expect(archiveResult.objects).toContainEqual(
      expect.objectContaining({ value: "Café" }),
    );
    const interfaceBuilderResult = await analyzeInterfaceBuilderBundle(input);
    expect(interfaceBuilderResult.documents).toHaveLength(1);
    expect(interfaceBuilderResult.documents[0]?.relative_path).toBe(
      "Panel.nib",
    );
  },
);

it.each(["REA-UNSUPPORTED", "ISO-8859-1"])(
  "reports unsupported keyed archive encoding %s instead of substituting UTF-8 text",
  async (declaration) => {
    const input = await fixture(declaration);
    await expect(
      inspectBundleKeyedArchive({
        ...input,
        parameters: { path: "Panel.nib" },
      }),
    ).rejects.toMatchObject({
      reason: "format",
      message: expect.stringContaining(declaration),
    });
  },
);

it.each(["REA-UNSUPPORTED", "ISO-8859-1"])(
  "reports unsupported Interface Builder encoding %s without graph substitution",
  async (declaration) => {
    const result = await analyzeInterfaceBuilderBundle(
      await fixture(declaration),
    );
    expect(result.documents).toEqual([]);
    expect(result.graph.nodes).toEqual([]);
    expect(result.graph.coverage).toContainEqual(
      expect.objectContaining({
        facet: "archive_decode",
        status: "partial",
        reason: "one_or_more_archives_invalid",
      }),
    );
    expect(result.graph.truncated).toBe(true);
  },
);
