import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { DirectoryArtifactReader } from "../DirectoryArtifactReader.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import { analyzeInterfaceBuilderBundle } from "./InterfaceBuilderAnalysis.js";
import {
  appleAssetCatalogInputSchema,
  parseAppleAssetCatalogRecords,
  projectAppleAssetCatalogPage,
} from "../../domain/apple/appleAssetCatalog.js";
import { execFileOutput } from "../../process/ExecFileOutput.js";

const ASSETUTIL = "/usr/bin/assetutil";
const MAX_CATALOG_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_METADATA_BYTES = 64 * 1024 * 1024;
const RESOURCE_KEY_FIELDS = new Set([
  "image",
  "imageName",
  "image_name",
  "resourceName",
  "resource_name",
  "assetName",
  "asset_name",
  "UIImageName",
  "NSImageName",
]);

/** Inspect compiled asset catalog metadata without extracting rendition bytes. */
export const analyzeAppleAssetCatalogs = async (input: {
  readonly bundlePath: string;
  readonly targetSha256: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly page?: unknown;
  readonly signal?: AbortSignal;
  readonly runAssetUtil?: (
    path: string,
    signal?: AbortSignal,
  ) => Promise<string>;
}) => {
  if (process.platform !== "darwin" && input.runAssetUtil === undefined)
    throw new ArtifactReaderFailure(
      "unavailable",
      "Apple asset catalog inspection requires macOS assetutil",
    );
  const page = appleAssetCatalogInputSchema.parse(input.page ?? {});
  const reader = new DirectoryArtifactReader(input.bundlePath);
  const catalogs: {
    path: string;
    sha256: string;
    records: ReturnType<typeof parseAppleAssetCatalogRecords>;
  }[] = [];
  const uninspected: string[] = [];
  let totalMetadataBytes = 0;
  try {
    for await (const entry of reader.entries(input.signal)) {
      if (!entry.path.endsWith("Assets.car")) continue;
      if (entry.kind !== "file") {
        uninspected.push(`${entry.path} (${entry.kind})`);
        continue;
      }
      const inspected = await inspectAssetCatalogEntry({
        reader,
        entry,
        runAssetUtil:
          input.runAssetUtil ??
          ((path, signal) => runAssetUtil(path, input.environment, signal)),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      totalMetadataBytes += inspected.metadataBytes;
      if (totalMetadataBytes > MAX_TOTAL_METADATA_BYTES)
        throw new ArtifactReaderFailure(
          "limit",
          `Combined asset catalog metadata exceeds ${MAX_TOTAL_METADATA_BYTES} bytes`,
        );
      catalogs.push(inspected.catalog);
    }
  } finally {
    await reader.close();
  }
  // Without any readable catalog, unmatched resource keys would overstate an
  // absence that a skipped catalog entry may contradict.
  if (catalogs.length === 0 && uninspected.length > 0)
    throw new ArtifactReaderFailure(
      "path",
      `Asset catalog entries are not regular files and were not inspected: ${uninspected.join(", ")}`,
    );
  const interfaceBuilder = await analyzeInterfaceBuilderBundle({
    bundlePath: input.bundlePath,
    targetSha256: input.targetSha256,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const resourceReferences = collectInterfaceBuilderResourceKeys(
    interfaceBuilder.graph.nodes,
  );
  const result = projectAppleAssetCatalogPage({
    targetSha256: input.targetSha256,
    catalogs,
    offset: page.offset,
    limit: page.limit,
    resourceReferences,
  });
  return {
    ...result,
    limitations: [
      ...result.limitations,
      // An app without a compiled catalog is an observed empty inventory, not
      // a missing host tool.
      ...(catalogs.length === 0
        ? [
            "No compiled Assets.car catalog was found among the app bundle's regular files (symlinks are not followed); any resource keys are reported as unmatched.",
          ]
        : []),
      ...(uninspected.length === 0
        ? []
        : [
            `Asset catalog entries that are not regular files were not inspected, so resource keys reported as unmatched may resolve there: ${uninspected.join(", ")}`,
          ]),
      "Exact resource-key joins use only recognized image or asset key fields on decoded Interface Builder resource objects; other archive resource references are not inferred.",
      ...(interfaceBuilder.graph.truncated
        ? [
            "Interface Builder resource-key joins may be incomplete because the decoded UI graph was truncated.",
          ]
        : []),
    ],
  };
};

const inspectAssetCatalogEntry = async (input: {
  readonly reader: DirectoryArtifactReader;
  readonly entry: import("../ArtifactReader.js").ArtifactEntry;
  readonly runAssetUtil: (
    path: string,
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly signal?: AbortSignal;
}) => {
  const { entry, reader, signal } = input;
  const sha256 = await digestBounded(reader, entry, signal);
  const before = await lstat(entry.adapterKey);
  if (
    entry.sourceIdentity === undefined ||
    before.dev !== entry.sourceIdentity.device ||
    before.ino !== entry.sourceIdentity.inode
  )
    throw new ArtifactReaderFailure(
      "integrity",
      `Asset catalog changed before inspection: ${entry.path}`,
    );
  const output = await input.runAssetUtil(entry.adapterKey, signal);
  const after = await lstat(entry.adapterKey);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    (await digestBounded(reader, entry, signal)) !== sha256
  )
    throw new ArtifactReaderFailure(
      "integrity",
      `Asset catalog changed during inspection: ${entry.path}`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (cause: unknown) {
    throw new ArtifactReaderFailure(
      "format",
      `assetutil returned invalid JSON for ${entry.path}`,
      { cause },
    );
  }
  try {
    return {
      catalog: {
        path: entry.path,
        sha256,
        records: parseAppleAssetCatalogRecords(parsed),
      },
      metadataBytes: Buffer.byteLength(output, "utf8"),
    };
  } catch (cause: unknown) {
    throw new ArtifactReaderFailure(
      "format",
      `assetutil returned an unsupported record for ${entry.path}`,
      { cause },
    );
  }
};

/** Return only explicit image or asset fields from decoded resource objects. */
export const collectInterfaceBuilderResourceKeys = (
  nodes: readonly {
    readonly id: string;
    readonly kind: string;
    readonly name?: string;
    readonly attributes: Readonly<Record<string, unknown>>;
    readonly evidence: readonly {
      readonly artifact_path: string | null;
      readonly artifact_sha256: string | null;
    }[];
  }[],
) =>
  nodes.flatMap((node) => {
    const source = node.evidence.find(
      (item) => item.artifact_path !== null && item.artifact_sha256 !== null,
    );
    const sourcePath = source?.artifact_path;
    const sourceArchiveSha256 = source?.artifact_sha256;
    if (sourcePath == null || sourceArchiveSha256 == null) return [];
    return Object.entries(node.attributes).flatMap(([field, value]) =>
      RESOURCE_KEY_FIELDS.has(field) &&
      typeof value === "string" &&
      value.length > 0
        ? [
            {
              sourceNodeId: node.id,
              sourcePath,
              sourceArchiveSha256,
              field,
              key: value,
            },
          ]
        : [],
    );
  });

const runAssetUtil = async (
  path: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  signal?: AbortSignal,
): Promise<string> => {
  try {
    return (
      await execFileOutput(ASSETUTIL, ["--info", path], {
        env: environment,
        timeout: 60_000,
        maxBuffer: MAX_CATALOG_BYTES,
        ...(signal === undefined ? {} : { signal }),
      })
    ).stdout;
  } catch (cause: unknown) {
    if (signal?.aborted === true)
      throw new ArtifactReaderFailure(
        "cancelled",
        "Asset catalog inspection cancelled",
      );
    const code =
      typeof cause === "object" && cause !== null && "code" in cause
        ? cause.code
        : undefined;
    throw new ArtifactReaderFailure(
      code === "ENOENT"
        ? "unavailable"
        : code === "ETIMEDOUT" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          ? "limit"
          : "io",
      `assetutil failed${code === undefined ? "" : ` (${String(code)})`}`,
      { cause },
    );
  }
};

const digestBounded = async (
  reader: DirectoryArtifactReader,
  entry: import("../ArtifactReader.js").ArtifactEntry,
  signal?: AbortSignal,
): Promise<string> => {
  if (entry.declaredSize === null || entry.declaredSize > MAX_CATALOG_BYTES)
    throw new ArtifactReaderFailure(
      "limit",
      `Asset catalog exceeds ${MAX_CATALOG_BYTES} bytes: ${entry.path}`,
    );
  const stream = await reader.open(entry, signal);
  const hash = createHash("sha256");
  let length = 0;
  for await (const chunk of stream) {
    if (signal?.aborted === true)
      throw new ArtifactReaderFailure(
        "cancelled",
        "Asset catalog inspection cancelled",
      );
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_CATALOG_BYTES)
      throw new ArtifactReaderFailure(
        "limit",
        `Asset catalog exceeds byte limit: ${entry.path}`,
      );
    hash.update(bytes);
  }
  return hash.digest("hex");
};
