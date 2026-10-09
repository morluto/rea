import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import {
  analyzeAppleAssetCatalogs,
  collectInterfaceBuilderResourceKeys,
} from "./AppleAssetCatalogAnalysis.js";

describe("Apple asset catalog application workflow", () => {
  it("joins only explicit resource-key fields with archive provenance", () => {
    expect(
      collectInterfaceBuilderResourceKeys([
        {
          id: "ib:Main.nib:object:2",
          kind: "resource",
          name: "Decorative image",
          attributes: {
            imageName: "Toolbar",
            title: "not-an-asset-key",
            image: 42,
          },
          evidence: [
            {
              artifact_path: "Contents/Resources/Main.nib",
              artifact_sha256: "d".repeat(64),
            },
          ],
        },
        {
          id: "ib:Main.nib:object:3",
          kind: "control",
          name: "Toolbar",
          attributes: { title: "not-an-asset-key" },
          evidence: [],
        },
      ]),
    ).toEqual([
      {
        sourceNodeId: "ib:Main.nib:object:2",
        sourcePath: "Contents/Resources/Main.nib",
        sourceArchiveSha256: "d".repeat(64),
        field: "imageName",
        key: "Toolbar",
      },
    ]);
  });

  it("reports an app without compiled catalogs as an empty observed inventory", async () => {
    const bundle = await createTestTempDirectory("rea-asset-catalog-absent-");
    await mkdir(join(bundle, "Contents", "Resources"), { recursive: true });
    await writeFile(join(bundle, "Contents", "Resources", "icon.icns"), "");
    const result = await analyzeAppleAssetCatalogs({
      environment: {},
      bundlePath: bundle,
      targetSha256: "a".repeat(64),
      runAssetUtil: () => {
        throw new Error("assetutil must not run without a catalog");
      },
    });
    expect(result).toMatchObject({
      catalogs: [],
      total_records: 0,
      records: [],
      resource_key_matches: [],
      next_offset: null,
      truncated: false,
    });
    expect(result.limitations).toContain(
      "No compiled Assets.car catalog was found among the app bundle's regular files (symlinks are not followed); any resource keys are reported as unmatched.",
    );
  });

  it("does not report absence when the only catalog entry is a symlink", async () => {
    const bundle = await createTestTempDirectory("rea-asset-catalog-link-");
    const resources = join(bundle, "Contents", "Resources");
    await mkdir(resources, { recursive: true });
    await writeFile(join(bundle, "outside.car"), "catalog");
    await symlink("../../outside.car", join(resources, "Assets.car"));
    const rejected = await analyzeAppleAssetCatalogs({
      environment: {},
      bundlePath: bundle,
      targetSha256: "a".repeat(64),
      runAssetUtil: () => Promise.resolve("[]"),
    }).catch((cause: unknown) => cause);
    expect(rejected).toBeInstanceOf(ArtifactReaderFailure);
    expect(rejected).toMatchObject({
      reason: "path",
      message: expect.stringContaining(
        "Contents/Resources/Assets.car (symlink)",
      ),
    });
  });

  it("discloses skipped catalog entries beside inspected catalogs", async () => {
    const bundle = await createTestTempDirectory("rea-asset-catalog-mixed-");
    const resources = join(bundle, "Contents", "Resources");
    await mkdir(join(resources, "Nested"), { recursive: true });
    await writeFile(join(resources, "Assets.car"), "catalog");
    await symlink("../Assets.car", join(resources, "Nested", "Assets.car"));
    const result = await analyzeAppleAssetCatalogs({
      environment: {},
      bundlePath: bundle,
      targetSha256: "a".repeat(64),
      runAssetUtil: () => Promise.resolve("[]"),
    });
    expect(result.catalogs.map(({ path }) => path)).toEqual([
      "Contents/Resources/Assets.car",
    ]);
    expect(result.limitations).toContainEqual(
      expect.stringContaining("Contents/Resources/Nested/Assets.car (symlink)"),
    );
    expect(result.limitations).not.toContainEqual(
      expect.stringContaining("No compiled Assets.car catalog"),
    );
  });
});
