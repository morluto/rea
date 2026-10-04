import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeAppleAssetCatalogs,
  collectInterfaceBuilderResourceKeys,
} from "./AppleAssetCatalogAnalysis.js";

const roots: string[] = [];
const createBundle = async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-assets-test-"));
  roots.push(root);
  await mkdir(join(root, "Test.app", "Contents", "Resources"), {
    recursive: true,
  });
  const path = join(root, "Test.app", "Contents", "Resources", "Assets.car");
  await writeFile(path, "fixture catalog bytes");
  return join(root, "Test.app");
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

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

  it("hashes the source and passes the exact file to assetutil with a page", async () => {
    const bundlePath = await createBundle();
    const observed: string[] = [];
    const result = await analyzeAppleAssetCatalogs({
      bundlePath,
      targetSha256: "f".repeat(64),
      page: { offset: 0, limit: 1 },
      runAssetUtil: async (path) => {
        observed.push(path);
        return JSON.stringify([
          { AssetStorageVersion: 1 },
          { Name: "Button", RenditionName: "button.png" },
        ]);
      },
    });
    expect(observed).toEqual([
      join(bundlePath, "Contents", "Resources", "Assets.car"),
    ]);
    expect(result.total_records).toBe(2);
    expect(result.records).toHaveLength(1);
    expect(result.next_offset).toBe(1);
    expect(result.catalogs[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("reports invalid utility output as an artifact format failure", async () => {
    const bundlePath = await createBundle();
    await expect(
      analyzeAppleAssetCatalogs({
        bundlePath,
        targetSha256: "f".repeat(64),
        runAssetUtil: async () => "not json",
      }),
    ).rejects.toMatchObject({ reason: "format" });
  });
});
