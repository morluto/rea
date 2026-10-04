import { describe, expect, it } from "vitest";

import {
  appleAssetCatalogInputSchema,
  parseAppleAssetCatalogRecords,
  projectAppleAssetCatalogPage,
} from "./appleAssetCatalog.js";

describe("compiled Apple asset catalog projection", () => {
  it("preserves metadata and paginates across catalog boundaries", () => {
    const catalogs = [
      {
        path: "Resources/A/Assets.car",
        sha256: "a".repeat(64),
        records: parseAppleAssetCatalogRecords([
          { AssetStorageVersion: 1, Platform: "ios" },
          {
            Name: "Toolbar",
            RenditionName: "toolbar@2x.png",
            Scale: 2,
            Idiom: "iphone",
            Locale: "en",
            Appearance: "dark",
          },
        ]),
      },
      {
        path: "Resources/B/Assets.car",
        sha256: "b".repeat(64),
        records: parseAppleAssetCatalogRecords([
          {
            Name: "Toolbar",
            RenditionName: "toolbar~ipad.png",
            PixelWidth: 64,
          },
        ]),
      },
    ];
    const first = projectAppleAssetCatalogPage({
      targetSha256: "c".repeat(64),
      catalogs,
      offset: 0,
      limit: 2,
      resourceReferences: [
        {
          sourceNodeId: "ib:Main.nib:object:1",
          sourcePath: "Main.nib",
          sourceArchiveSha256: "d".repeat(64),
          field: "imageName",
          key: "Toolbar",
        },
        {
          sourceNodeId: "ib:Main.nib:object:2",
          sourcePath: "Main.nib",
          sourceArchiveSha256: "d".repeat(64),
          field: "imageName",
          key: "Missing",
        },
      ],
    });
    expect(first.records.map(({ kind }) => kind)).toEqual([
      "catalog",
      "rendition",
    ]);
    expect(first.records[1]?.metadata.Scale).toBe(2);
    expect(first.records[1]?.metadata.Idiom).toBe("iphone");
    expect(first.records[1]?.metadata.Locale).toBe("en");
    expect(first.records[1]?.metadata.Appearance).toBe("dark");
    expect(first.resource_key_matches).toEqual([
      expect.objectContaining({ status: "ambiguous", key: "Toolbar" }),
      expect.objectContaining({ status: "unmatched", key: "Missing" }),
    ]);
    expect(first.next_offset).toBe(2);
    expect(first.truncated).toBe(true);

    const second = projectAppleAssetCatalogPage({
      targetSha256: "c".repeat(64),
      catalogs,
      offset: 2,
      limit: 2,
    });
    expect(second.records[0]?.catalog_path).toBe("Resources/B/Assets.car");
    expect(second.next_offset).toBeNull();
    expect(second.total_records).toBe(3);
  });

  it("rejects malformed and overlarge pages and invalid utility data", () => {
    expect(appleAssetCatalogInputSchema.safeParse({ offset: -1 }).success).toBe(
      false,
    );
    expect(
      appleAssetCatalogInputSchema.safeParse({ limit: 10_001 }).success,
    ).toBe(false);
    expect(() =>
      parseAppleAssetCatalogRecords({ Name: "not an array" }),
    ).toThrow(/JSON array/u);
    expect(() => parseAppleAssetCatalogRecords([null])).toThrow(/record 0/u);
  });
});
