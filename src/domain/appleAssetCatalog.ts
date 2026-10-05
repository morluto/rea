import { z } from "zod";

import { jsonValueSchema } from "./jsonValue.js";
import { AnalysisOutputError } from "./analysisErrorCore.js";

/** Caller-controlled page bounds for compiled Apple asset metadata. */
export const appleAssetCatalogInputSchema = z.strictObject({
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(10_000).default(1_000),
});

const catalogSchema = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  record_count: z.number().int().nonnegative(),
});

const recordSchema = z.strictObject({
  catalog_path: z.string().min(1),
  catalog_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  index: z.number().int().nonnegative(),
  kind: z.enum(["catalog", "rendition"]),
  asset_name: z.string().nullable(),
  rendition_name: z.string().nullable(),
  metadata: z.record(z.string(), jsonValueSchema),
});

const resourceKeyMatchSchema = z.strictObject({
  source_node_id: z.string().min(1),
  source_path: z.string().min(1),
  source_archive_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  field: z.string().min(1),
  key: z.string().min(1),
  status: z.enum(["matched", "ambiguous", "unmatched"]),
  renditions: z.array(
    z.strictObject({
      catalog_path: z.string().min(1),
      catalog_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      record_index: z.number().int().nonnegative(),
      rendition_name: z.string().nullable(),
    }),
  ),
});

/** Normalized result returned by asset catalog inspection. */
export const appleAssetCatalogResultSchema = z.strictObject({
  target_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  catalogs: z.array(catalogSchema),
  total_records: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  records: z.array(recordSchema),
  resource_key_matches: z.array(resourceKeyMatchSchema),
  next_offset: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
  limitations: z.array(z.string()),
});

export type AppleAssetCatalogRecord = z.infer<typeof recordSchema>;

/** Parse assetutil JSON records without discarding format-specific metadata. */
export const parseAppleAssetCatalogRecords = (
  value: unknown,
): readonly Readonly<
  Record<string, ReturnType<typeof jsonValueSchema.parse>>
>[] => {
  if (!Array.isArray(value))
    throw new AnalysisOutputError(
      "inspect_asset_catalog",
      "assetutil output must be a JSON array",
    );
  return value.map((record, index) => {
    const parsed = z.record(z.string(), jsonValueSchema).safeParse(record);
    if (!parsed.success)
      throw new AnalysisOutputError(
        "inspect_asset_catalog",
        `assetutil record ${index} is not a JSON object`,
        { cause: parsed.error },
      );
    return parsed.data;
  });
};

/** Project catalog records and apply stable global pagination. */
export const projectAppleAssetCatalogPage = (input: {
  readonly targetSha256: string;
  readonly catalogs: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly records: readonly Readonly<
      Record<string, ReturnType<typeof jsonValueSchema.parse>>
    >[];
  }[];
  readonly offset: number;
  readonly limit: number;
  readonly resourceReferences?: readonly {
    readonly sourceNodeId: string;
    readonly sourcePath: string;
    readonly sourceArchiveSha256: string;
    readonly field: string;
    readonly key: string;
  }[];
}) => {
  const all = input.catalogs.flatMap((catalog) =>
    catalog.records.map((metadata, index): AppleAssetCatalogRecord => ({
      catalog_path: catalog.path,
      catalog_sha256: catalog.sha256,
      index,
      kind:
        typeof metadata.RenditionName === "string" ||
        typeof metadata.Name === "string"
          ? "rendition"
          : "catalog",
      asset_name: typeof metadata.Name === "string" ? metadata.Name : null,
      rendition_name:
        typeof metadata.RenditionName === "string"
          ? metadata.RenditionName
          : null,
      metadata,
    })),
  );
  const records = all.slice(input.offset, input.offset + input.limit);
  const next = input.offset + records.length;
  const recordsByAssetName = new Map<string, typeof all>();
  for (const record of all) {
    if (record.kind !== "rendition" || record.asset_name === null) continue;
    const matches = recordsByAssetName.get(record.asset_name) ?? [];
    matches.push(record);
    recordsByAssetName.set(record.asset_name, matches);
  }
  const resourceKeyMatches = (input.resourceReferences ?? []).map((source) => {
    const matches = recordsByAssetName.get(source.key) ?? [];
    return {
      source_node_id: source.sourceNodeId,
      source_path: source.sourcePath,
      source_archive_sha256: source.sourceArchiveSha256,
      field: source.field,
      key: source.key,
      status:
        matches.length === 0
          ? ("unmatched" as const)
          : matches.length === 1
            ? ("matched" as const)
            : ("ambiguous" as const),
      renditions: matches.map((record) => ({
        catalog_path: record.catalog_path,
        catalog_sha256: record.catalog_sha256,
        record_index: record.index,
        rendition_name: record.rendition_name,
      })),
    };
  });
  return appleAssetCatalogResultSchema.parse({
    target_sha256: input.targetSha256,
    catalogs: input.catalogs.map(
      ({ path, sha256, records: catalogRecords }) => ({
        path,
        sha256,
        record_count: catalogRecords.length,
      }),
    ),
    total_records: all.length,
    offset: input.offset,
    limit: input.limit,
    records,
    resource_key_matches: resourceKeyMatches,
    next_offset: next < all.length ? next : null,
    truncated: input.offset > 0 || next < all.length,
    limitations: [
      "Rendition metadata is reported as emitted by the installed assetutil version; private fields and platform-specific interpretations are not normalized.",
      "Asset catalog inspection does not decode or extract rendition image bytes.",
    ],
  });
};
