import { createHash } from "node:crypto";

import { digestCanonicalValue } from "../domain/canonicalDigest.js";
import { decodeStrictUtf8 } from "../domain/strictUtf8.js";
import { Budget } from "../domain/budget.js";
import { parseJsonWithDuplicatePolicy } from "../domain/jsonDuplicateMember.js";
import {
  decodeLimit,
  malformedInput,
  ParseFailureError,
} from "../domain/parseFailure.js";
import {
  isOciConfigMediaType,
  isOciIndexMediaType,
  isOciKnownMediaType,
  isOciManifestMediaType,
  ociBlobPath,
  parseOciDigest,
  OCI_IMAGE_LAYOUT_FORMAT,
  type InspectOciImageLayoutInput,
  type OciImageLayout,
  type OciImageLayoutBlob,
  type OciImageLayoutFinding,
  type OciImageLayoutImage,
  type OciImageLayoutIndex,
} from "../domain/oci/imageLayout.js";
import { isRecord } from "../kernel/isRecord.js";
import {
  abortIfNeeded,
  ArtifactReaderFailure,
  digestReadableToCompletion,
  DirectoryArtifactTraversalLimit,
  readArtifactFileChunks,
  streamChunkToBuffer,
  type DirectoryArtifactEntry,
  type DirectoryArtifactReader,
} from "../resources/index.js";
import type { FileSnapshotPartialObservation } from "../domain/fileSnapshotObservation.js";

/** Limitation wording owned by the parser; tests assert delivery through these. */
export const OCI_IMAGE_LAYOUT_LIMITATIONS = {
  directoryOnly:
    "This workflow reads an OCI image-layout directory without decompressing layers, executing the image, or contacting a registry. Tar image layouts are not inspected.",
  noLayerContents:
    "Layer contents are not listed; decompression is a follow-up.",
  envRedacted:
    "Config Env values are omitted (null) because include_env_values was set to false.",
} as const;

export class OciImageLayoutRefusal extends ParseFailureError {
  constructor(
    failure: ParseFailureError["failure"],
    readonly layoutObservation: FileSnapshotPartialObservation | undefined,
    options?: ErrorOptions,
  ) {
    super(failure, options);
  }
}

const BASE_LIMITATIONS = [
  OCI_IMAGE_LAYOUT_LIMITATIONS.directoryOnly,
  OCI_IMAGE_LAYOUT_LIMITATIONS.noLayerContents,
] as const;

/** Present string as written; blank or whitespace-only values count as absent. */
const nonempty = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const asStringArray = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    items.push(item);
  }
  return items;
};

const objectKeys = (value: unknown): string[] =>
  isRecord(value) ? Object.keys(value) : [];

const annotationsOf = (value: unknown): { name: string; value: string }[] => {
  if (!isRecord(value)) return [];
  const annotations: { name: string; value: string }[] = [];
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "string") annotations.push({ name, value: entry });
  }
  return annotations;
};

const platformOf = (
  value: unknown,
): OciImageLayoutIndex["entries"][number]["platform"] => {
  if (!isRecord(value)) return null;
  return {
    os: nonempty(value.os),
    architecture: nonempty(value.architecture),
    variant: nonempty(value.variant),
    os_version: nonempty(value["os.version"]),
  };
};

const descriptorOf = (
  value: unknown,
): OciImageLayoutIndex["entries"][number] | undefined => {
  if (!isRecord(value)) return undefined;
  const mediaType = nonempty(value.mediaType) ?? nonempty(value.media_type);
  const digest = nonempty(value.digest);
  if (mediaType === null || digest === null) return undefined;
  const size =
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0
      ? value.size
      : null;
  return {
    media_type: mediaType,
    digest,
    size,
    platform: platformOf(value.platform),
    annotations: annotationsOf(value.annotations),
  };
};

/** What a descriptor that `descriptorOf` cannot model is missing. */
const descriptorDefect = (value: unknown): string => {
  if (!isRecord(value)) return "is not a JSON object";
  const missing = [
    ...((nonempty(value.mediaType) ?? nonempty(value.media_type))
      ? []
      : ["a string mediaType"]),
    ...(nonempty(value.digest) ? [] : ["a string digest"]),
  ];
  const digest = nonempty(value.digest);
  return `lacks ${missing.join(" and ")}${digest === null ? "" : ` (digest ${digest})`}`;
};

interface JsonDocument {
  readonly value: unknown;
  readonly sha256: string;
  readonly bytes: number;
}

const jsonLimit = (label: string, maximum: number, required: number) =>
  decodeLimit(
    OCI_IMAGE_LAYOUT_FORMAT,
    `${label} exceeds the ${String(maximum)}-byte budget.`,
    { name: "max_json_bytes", maximum, required },
  );

class BlobOversize extends Error {
  constructor(
    readonly maximum: number,
    readonly required: number,
  ) {
    super("blob oversize");
  }
}

const readJsonDocument = async (
  reader: DirectoryArtifactReader,
  entry: DirectoryArtifactEntry,
  maximum: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<JsonDocument> => {
  if (entry.kind !== "file")
    throw malformedInput(
      OCI_IMAGE_LAYOUT_FORMAT,
      `${label} is not a regular file.`,
    );
  if (entry.declaredSize !== null && entry.declaredSize > maximum)
    throw jsonLimit(label, maximum, entry.declaredSize);
  try {
    return await reader.inspectFile(
      entry,
      async (file) => {
        const budget = new Budget(maximum);
        const hash = createHash("sha256");
        const chunks: Buffer[] = [];
        for await (const raw of readArtifactFileChunks(file, { signal })) {
          abortIfNeeded(signal);
          const chunk = streamChunkToBuffer(raw);
          budget.charge(chunk.length, () =>
            jsonLimit(label, maximum, budget.used + chunk.length),
          );
          hash.update(chunk);
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        let text: string;
        try {
          text = decodeStrictUtf8(bytes, "strip-signature");
        } catch (cause: unknown) {
          throw malformedInput(
            OCI_IMAGE_LAYOUT_FORMAT,
            `${label} is not valid UTF-8.`,
            { cause },
          );
        }
        const parsed = parseJsonWithDuplicatePolicy(text, "reject");
        if (!parsed.ok) {
          if (parsed.duplicate !== undefined)
            throw malformedInput(
              OCI_IMAGE_LAYOUT_FORMAT,
              `${label} repeats object member ${JSON.stringify(parsed.duplicate.name)}.`,
            );
          throw malformedInput(
            OCI_IMAGE_LAYOUT_FORMAT,
            `${label} is not valid JSON.`,
            { cause: parsed.cause },
          );
        }
        return {
          value: parsed.value,
          sha256: hash.digest("hex"),
          bytes: bytes.length,
        };
      },
      signal,
    );
  } catch (cause: unknown) {
    if (cause instanceof ParseFailureError) throw cause;
    if (
      cause instanceof ArtifactReaderFailure &&
      cause.cause instanceof ParseFailureError
    )
      throw cause.cause;
    throw cause;
  }
};

interface ReferencedBlob {
  digest: string;
  mediaType: string | null;
  declaredSize: number | null;
  /** Every distinct size the descriptors referencing this blob declared. */
  declaredSizes: number[];
}

const recordFinding = (
  findings: OciImageLayoutFinding[],
  kind: OciImageLayoutFinding["kind"],
  message: string,
  digest: string | null = null,
  path: string | null = null,
): void => {
  findings.push({ kind, digest, path, message });
};

const hashBlob = async (
  reader: DirectoryArtifactReader,
  entry: DirectoryArtifactEntry,
  input: InspectOciImageLayoutInput,
  signal: AbortSignal | undefined,
  algorithm: "sha256" | "sha512" | undefined,
): Promise<{
  sha256: string;
  sha512: string | null;
  bytes: number;
}> => {
  if (entry.declaredSize !== null && entry.declaredSize > input.max_blob_bytes)
    throw new BlobOversize(input.max_blob_bytes, entry.declaredSize);
  const stream = await reader.open(entry, signal);
  const sha512 = algorithm === "sha512" ? createHash("sha512") : undefined;
  const budget = new Budget(input.max_blob_bytes);
  try {
    const digest = await digestReadableToCompletion(
      stream,
      signal,
      undefined,
      (chunk) => {
        budget.charge(chunk.length, () => {
          throw new BlobOversize(
            input.max_blob_bytes,
            budget.used + chunk.length,
          );
        });
        sha512?.update(chunk);
      },
    );
    return {
      sha256: digest.sha256,
      sha512: sha512 === undefined ? null : sha512.digest("hex"),
      bytes: digest.bytes,
    };
  } finally {
    stream.destroy();
  }
};

const envBindings = (
  value: unknown,
  includeValues: boolean,
): OciImageLayoutImage["env"] => {
  if (!Array.isArray(value)) return [];
  const bindings: OciImageLayoutImage["env"] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) continue;
    const separator = item.indexOf("=");
    const name = separator === -1 ? item : item.slice(0, separator);
    if (name.length === 0) continue;
    bindings.push({
      name,
      value:
        includeValues && separator !== -1 ? item.slice(separator + 1) : null,
    });
  }
  return bindings;
};

const historyOf = (value: unknown): OciImageLayoutImage["history"] => {
  if (!Array.isArray(value)) return [];
  const history: OciImageLayoutImage["history"] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    history.push({
      created: nonempty(item.created),
      created_by:
        typeof item.created_by === "string"
          ? item.created_by
          : typeof item.createdBy === "string"
            ? item.createdBy
            : null,
      empty_layer:
        typeof item.empty_layer === "boolean"
          ? item.empty_layer
          : typeof item.emptyLayer === "boolean"
            ? item.emptyLayer
            : null,
      comment: typeof item.comment === "string" ? item.comment : null,
    });
  }
  return history;
};

const parseConfig = (
  value: unknown,
  includeEnvValues: boolean,
): Pick<
  OciImageLayoutImage,
  | "architecture"
  | "os"
  | "variant"
  | "created"
  | "author"
  | "user"
  | "env"
  | "entrypoint"
  | "cmd"
  | "working_dir"
  | "exposed_ports"
  | "volumes"
  | "labels"
  | "stop_signal"
  | "rootfs_diff_ids"
  | "history"
> => {
  if (!isRecord(value))
    return {
      architecture: null,
      os: null,
      variant: null,
      created: null,
      author: null,
      user: null,
      env: [],
      entrypoint: null,
      cmd: null,
      working_dir: null,
      exposed_ports: [],
      volumes: [],
      labels: [],
      stop_signal: null,
      rootfs_diff_ids: [],
      history: [],
    };
  const config = isRecord(value.config) ? value.config : {};
  const rootfs = isRecord(value.rootfs) ? value.rootfs : {};
  const diffIds = Array.isArray(rootfs.diff_ids)
    ? rootfs.diff_ids.filter((item): item is string => typeof item === "string")
    : [];
  return {
    architecture: nonempty(value.architecture),
    os: nonempty(value.os),
    variant: nonempty(value.variant),
    created: nonempty(value.created),
    author: nonempty(value.author),
    user: nonempty(config.User) ?? nonempty(config.user),
    env: envBindings(config.Env ?? config.env, includeEnvValues),
    entrypoint: asStringArray(config.Entrypoint ?? config.entrypoint),
    cmd: asStringArray(config.Cmd ?? config.cmd),
    working_dir: nonempty(config.WorkingDir) ?? nonempty(config.workingDir),
    exposed_ports: objectKeys(config.ExposedPorts ?? config.exposedPorts),
    volumes: objectKeys(config.Volumes ?? config.volumes),
    labels: annotationsOf(config.Labels ?? config.labels),
    stop_signal: nonempty(config.StopSignal) ?? nonempty(config.stopSignal),
    rootfs_diff_ids: diffIds,
    history: historyOf(value.history),
  };
};

const blobRecord = (
  digest: string,
  path: string,
  mediaType: string | null,
  declaredSize: number | null,
  referenced: boolean,
  kind: OciImageLayoutBlob["kind"],
  extras: Partial<OciImageLayoutBlob> = {},
): OciImageLayoutBlob => ({
  digest,
  path,
  media_type: mediaType,
  declared_size: declaredSize,
  observed_size: extras.observed_size ?? null,
  present: extras.present ?? kind === "file",
  hashed: extras.hashed ?? false,
  sha256: extras.sha256 ?? null,
  sha512: extras.sha512 ?? null,
  referenced,
  kind,
});

const refuse = (
  failure: ParseFailureError["failure"],
  layoutObservation: FileSnapshotPartialObservation | undefined,
  cause?: unknown,
): never => {
  throw new OciImageLayoutRefusal(
    failure,
    layoutObservation,
    cause === undefined ? undefined : { cause },
  );
};

/** Inventory one admitted OCI image-layout directory without layer decompression. */
export const parseOciImageLayout = async (
  reader: DirectoryArtifactReader,
  input: InspectOciImageLayoutInput,
  signal?: AbortSignal,
): Promise<OciImageLayout> => {
  const findings: OciImageLayoutFinding[] = [];
  const limitations: string[] = [...BASE_LIMITATIONS];
  if (!input.include_env_values)
    limitations.push(OCI_IMAGE_LAYOUT_LIMITATIONS.envRedacted);

  const entries: DirectoryArtifactEntry[] = [];
  try {
    for await (const entry of reader.entries(signal, {
      maximumEntries: input.max_entries,
      descendInto: (path) => path === "blobs" || path.startsWith("blobs/"),
    }))
      entries.push(entry);
  } catch (cause: unknown) {
    if (cause instanceof DirectoryArtifactTraversalLimit)
      throw decodeLimit(
        OCI_IMAGE_LAYOUT_FORMAT,
        `OCI image layout exceeds the ${String(input.max_entries)}-entry budget.`,
        {
          name: "max_entries",
          maximum: input.max_entries,
          required: cause.examinedEntries + 1,
        },
        { cause },
      );
    throw cause;
  }

  const byPath = new Map<string, DirectoryArtifactEntry>();
  for (const entry of entries) byPath.set(entry.path, entry);

  const layoutEntry = byPath.get("oci-layout");
  if (layoutEntry === undefined)
    throw malformedInput(
      OCI_IMAGE_LAYOUT_FORMAT,
      "Selected directory has no oci-layout file.",
    );
  if (layoutEntry.kind === "symlink")
    throw malformedInput(
      OCI_IMAGE_LAYOUT_FORMAT,
      "oci-layout is a symlink and was not followed.",
    );
  const layoutDocument = await readJsonDocument(
    reader,
    layoutEntry,
    input.max_json_bytes,
    signal,
    "oci-layout",
  );
  const layoutVersion = isRecord(layoutDocument.value)
    ? nonempty(layoutDocument.value.imageLayoutVersion)
    : null;
  if (layoutVersion === null)
    throw malformedInput(
      OCI_IMAGE_LAYOUT_FORMAT,
      "oci-layout is missing imageLayoutVersion.",
    );
  const layoutObservation: FileSnapshotPartialObservation = {
    kind: "file-snapshot-hash",
    path: "oci-layout",
    sha256: layoutDocument.sha256,
    bytes: layoutDocument.bytes,
  };
  let jsonBytesRead = layoutDocument.bytes;

  const indexEntry = byPath.get("index.json");
  if (indexEntry === undefined || indexEntry.kind === "symlink") {
    throw new OciImageLayoutRefusal(
      malformedInput(
        OCI_IMAGE_LAYOUT_FORMAT,
        indexEntry === undefined
          ? "Selected directory has no index.json file."
          : "index.json is a symlink and was not followed.",
      ).failure,
      layoutObservation,
    );
  }
  let indexDocument: JsonDocument;
  try {
    indexDocument = await readJsonDocument(
      reader,
      indexEntry,
      input.max_json_bytes,
      signal,
      "index.json",
    );
  } catch (cause: unknown) {
    if (cause instanceof ParseFailureError)
      refuse(cause.failure, layoutObservation, cause);
    throw cause;
  }
  jsonBytesRead += indexDocument.bytes;
  if (!isRecord(indexDocument.value)) {
    throw new OciImageLayoutRefusal(
      malformedInput(
        OCI_IMAGE_LAYOUT_FORMAT,
        "index.json root is not a JSON object.",
      ).failure,
      layoutObservation,
    );
  }
  const indexRoot = indexDocument.value;

  const referenced = new Map<string, ReferencedBlob>();
  const remember = (
    digest: string,
    mediaType: string | null,
    declaredSize: number | null,
  ): void => {
    const existing = referenced.get(digest);
    if (existing === undefined) {
      referenced.set(digest, {
        digest,
        mediaType,
        declaredSize,
        declaredSizes: declaredSize === null ? [] : [declaredSize],
      });
      return;
    }
    if (existing.mediaType === null && mediaType !== null)
      existing.mediaType = mediaType;
    if (declaredSize === null || existing.declaredSizes.includes(declaredSize))
      return;
    existing.declaredSize ??= declaredSize;
    existing.declaredSizes.push(declaredSize);
  };

  const indexes: OciImageLayoutIndex[] = [];
  const images: OciImageLayoutImage[] = [];
  const visited = new Set<string>();
  let processed = 0;
  const chargeEntry = (): void => {
    processed += 1;
    if (processed > input.max_entries)
      throw decodeLimit(
        OCI_IMAGE_LAYOUT_FORMAT,
        `OCI image layout exceeds the ${String(input.max_entries)}-entry budget.`,
        {
          name: "max_entries",
          maximum: input.max_entries,
          required: processed,
        },
      );
  };

  // A referenced index, manifest or config that could not be read leaves its
  // facts unexamined, whatever finding explains why.
  let referencedJsonSkipped = false;
  const readReferencedJson = async (
    digest: string,
    label: string,
  ): Promise<JsonDocument | undefined> => {
    const document = await readReferencedJsonDocument(digest, label);
    if (document === undefined) referencedJsonSkipped = true;
    return document;
  };
  const readReferencedJsonDocument = async (
    digest: string,
    label: string,
  ): Promise<JsonDocument | undefined> => {
    const parsed = parseOciDigest(digest);
    if (parsed === undefined) {
      recordFinding(
        findings,
        "unsupported_digest_algorithm",
        `Digest ${digest} uses an unsupported algorithm.`,
        digest,
      );
      return undefined;
    }
    const path = ociBlobPath(parsed);
    const entry = byPath.get(path);
    if (entry === undefined) {
      recordFinding(
        findings,
        "missing_blob",
        `Referenced blob ${digest} is missing.`,
        digest,
        path,
      );
      return undefined;
    }
    if (entry.kind === "symlink") {
      recordFinding(
        findings,
        "symlink_blob",
        `Referenced blob ${digest} is a symlink and was not followed.`,
        digest,
        path,
      );
      return undefined;
    }
    if (entry.kind !== "file") {
      recordFinding(
        findings,
        "missing_blob",
        `Referenced blob ${digest} is not a regular file.`,
        digest,
        path,
      );
      return undefined;
    }
    try {
      const document = await readJsonDocument(
        reader,
        entry,
        input.max_json_bytes,
        signal,
        label,
      );
      jsonBytesRead += document.bytes;
      return document;
    } catch (cause: unknown) {
      if (cause instanceof ParseFailureError && cause.kind === "limit")
        throw cause;
      recordFinding(
        findings,
        "malformed_blob_json",
        cause instanceof ParseFailureError
          ? cause.failure.detail
          : `${label} could not be decoded.`,
        digest,
        path,
      );
      return undefined;
    }
  };

  // Indexes are walked breadth-first so each one is first reached at the
  // shallowest depth any path gives it; a deeper first visit through a shared
  // index would otherwise hide what it reaches within max_index_depth.
  const queuedIndexes = new Set<string>();
  const indexQueue: { digest: string; mediaType: string; depth: number }[] = [];

  const walkIndex = async (
    digest: string,
    mediaType: string,
    document: JsonDocument,
    depth: number,
  ): Promise<void> => {
    if (visited.has(digest)) return;
    visited.add(digest);
    chargeEntry();
    if (depth > input.max_index_depth) {
      recordFinding(
        findings,
        "nested_index_depth_exceeded",
        `Nested index ${digest} exceeds max_index_depth ${String(input.max_index_depth)}.`,
        digest,
      );
      return;
    }
    if (!isRecord(document.value)) {
      recordFinding(
        findings,
        "malformed_blob_json",
        `Index ${digest} root is not a JSON object.`,
        digest,
      );
      return;
    }
    const schemaVersion =
      typeof document.value.schemaVersion === "number" &&
      Number.isSafeInteger(document.value.schemaVersion)
        ? document.value.schemaVersion
        : null;
    const manifests = Array.isArray(document.value.manifests)
      ? document.value.manifests
      : [];
    const indexEntries: OciImageLayoutIndex["entries"] = [];
    for (const [position, item] of manifests.entries()) {
      chargeEntry();
      const descriptor = descriptorOf(item);
      if (descriptor === undefined) {
        recordFinding(
          findings,
          "malformed_blob_json",
          `Index ${digest} manifests[${String(position)}] ${descriptorDefect(item)}; the entry is not modeled.`,
          digest,
        );
        continue;
      }
      indexEntries.push(descriptor);
      remember(descriptor.digest, descriptor.media_type, descriptor.size);
      if (!isOciKnownMediaType(descriptor.media_type))
        recordFinding(
          findings,
          "unknown_media_type",
          `Descriptor media type ${JSON.stringify(descriptor.media_type)} is unknown.`,
          descriptor.digest,
        );
      if (parseOciDigest(descriptor.digest) === undefined)
        recordFinding(
          findings,
          "unsupported_digest_algorithm",
          `Digest ${descriptor.digest} uses an unsupported algorithm.`,
          descriptor.digest,
        );
    }
    indexes.push({
      digest,
      media_type: mediaType,
      schema_version: schemaVersion,
      depth,
      entries: indexEntries,
    });
    for (const descriptor of indexEntries) {
      if (isOciIndexMediaType(descriptor.media_type)) {
        // Breadth-first, an index already queued was reached at this depth
        // or a shallower one.
        if (queuedIndexes.has(descriptor.digest)) continue;
        if (depth + 1 > input.max_index_depth) {
          recordFinding(
            findings,
            "nested_index_depth_exceeded",
            `Nested index ${descriptor.digest} exceeds max_index_depth ${String(input.max_index_depth)}.`,
            descriptor.digest,
          );
          continue;
        }
        queuedIndexes.add(descriptor.digest);
        indexQueue.push({
          digest: descriptor.digest,
          mediaType: descriptor.media_type,
          depth: depth + 1,
        });
        continue;
      }
      if (isOciManifestMediaType(descriptor.media_type))
        await walkManifest(descriptor.digest, descriptor.media_type);
    }
  };

  const walkManifest = async (
    digest: string,
    mediaType: string,
  ): Promise<void> => {
    if (visited.has(`manifest:${digest}`)) return;
    visited.add(`manifest:${digest}`);
    chargeEntry();
    const document = await readReferencedJson(digest, `manifest ${digest}`);
    if (document === undefined) return;
    if (!isRecord(document.value)) {
      recordFinding(
        findings,
        "malformed_blob_json",
        `Manifest ${digest} root is not a JSON object.`,
        digest,
      );
      return;
    }
    const configDescriptor = descriptorOf(document.value.config);
    if (configDescriptor === undefined && document.value.config !== undefined)
      recordFinding(
        findings,
        "malformed_blob_json",
        `Manifest ${digest} config ${descriptorDefect(document.value.config)}; the config is not modeled.`,
        digest,
      );
    const layers: OciImageLayoutImage["layers"] = [];
    const layerItems = Array.isArray(document.value.layers)
      ? document.value.layers
      : [];
    for (const [position, item] of layerItems.entries()) {
      chargeEntry();
      const descriptor = descriptorOf(item);
      if (descriptor === undefined) {
        recordFinding(
          findings,
          "malformed_blob_json",
          `Manifest ${digest} layers[${String(position)}] ${descriptorDefect(item)}; the layer is not modeled.`,
          digest,
        );
        continue;
      }
      remember(descriptor.digest, descriptor.media_type, descriptor.size);
      if (!isOciKnownMediaType(descriptor.media_type))
        recordFinding(
          findings,
          "unknown_media_type",
          `Layer media type ${JSON.stringify(descriptor.media_type)} is unknown.`,
          descriptor.digest,
        );
      const parsed = parseOciDigest(descriptor.digest);
      const path = parsed === undefined ? null : ociBlobPath(parsed);
      const entry = path === null ? undefined : byPath.get(path);
      layers.push({
        media_type: descriptor.media_type,
        digest: descriptor.digest,
        size: descriptor.size,
        present: entry?.kind === "file",
      });
    }
    let configFacts: ReturnType<typeof parseConfig> = parseConfig(
      {},
      input.include_env_values,
    );
    if (configDescriptor !== undefined) {
      remember(
        configDescriptor.digest,
        configDescriptor.media_type,
        configDescriptor.size,
      );
      if (
        configDescriptor.media_type !== null &&
        !isOciConfigMediaType(configDescriptor.media_type) &&
        !isOciKnownMediaType(configDescriptor.media_type)
      )
        recordFinding(
          findings,
          "unknown_media_type",
          `Config media type ${JSON.stringify(configDescriptor.media_type)} is unknown.`,
          configDescriptor.digest,
        );
      const configDocument = await readReferencedJson(
        configDescriptor.digest,
        `config ${configDescriptor.digest}`,
      );
      if (configDocument !== undefined)
        configFacts = parseConfig(
          configDocument.value,
          input.include_env_values,
        );
    }
    images.push({
      digest,
      media_type: mediaType,
      config_digest: configDescriptor?.digest ?? null,
      ...configFacts,
      layers,
    });
  };

  const topMediaType =
    nonempty(indexRoot.mediaType) ??
    nonempty(indexRoot.media_type) ??
    "application/vnd.oci.image.index.v1+json";
  const rootDigest = `sha256:${indexDocument.sha256}`;
  queuedIndexes.add(rootDigest);
  await walkIndex(rootDigest, topMediaType, indexDocument, 0);
  for (
    let next = indexQueue.shift();
    next !== undefined;
    next = indexQueue.shift()
  ) {
    const nested = await readReferencedJson(
      next.digest,
      `index ${next.digest}`,
    );
    if (nested !== undefined)
      await walkIndex(next.digest, next.mediaType, nested, next.depth);
  }

  const blobs: OciImageLayoutBlob[] = [];
  let blobsHashed = 0;

  for (const [digest, reference] of referenced) {
    const parsed = parseOciDigest(digest);
    if (parsed === undefined) {
      blobs.push(
        blobRecord(
          digest,
          digest,
          reference.mediaType,
          reference.declaredSize,
          true,
          "missing",
          { present: false },
        ),
      );
      continue;
    }
    const path = ociBlobPath(parsed);
    const entry = byPath.get(path);
    if (entry === undefined) {
      if (
        !findings.some(
          (finding) =>
            finding.kind === "missing_blob" && finding.digest === digest,
        )
      )
        recordFinding(
          findings,
          "missing_blob",
          `Referenced blob ${digest} is missing.`,
          digest,
          path,
        );
      blobs.push(
        blobRecord(
          digest,
          path,
          reference.mediaType,
          reference.declaredSize,
          true,
          "missing",
          { present: false },
        ),
      );
      continue;
    }
    if (entry.kind === "symlink") {
      if (
        !findings.some(
          (finding) =>
            finding.kind === "symlink_blob" && finding.digest === digest,
        )
      )
        recordFinding(
          findings,
          "symlink_blob",
          `Blob ${digest} is a symlink and was not followed.`,
          digest,
          path,
        );
      blobs.push(
        blobRecord(
          digest,
          path,
          reference.mediaType,
          reference.declaredSize,
          true,
          "symlink",
          { present: false },
        ),
      );
      continue;
    }
    if (entry.kind !== "file") {
      blobs.push(
        blobRecord(
          digest,
          path,
          reference.mediaType,
          reference.declaredSize,
          true,
          "other",
          { present: false },
        ),
      );
      continue;
    }
    // Each reference's declaration is checked against the one file.
    for (const declared of reference.declaredSizes)
      if (entry.declaredSize !== null && declared !== entry.declaredSize)
        recordFinding(
          findings,
          "size_mismatch",
          `Blob ${digest} declared size ${String(declared)} disagrees with file size ${String(entry.declaredSize)}.`,
          digest,
          path,
        );
    try {
      const hashed = await hashBlob(
        reader,
        entry,
        input,
        signal,
        parsed.algorithm,
      );
      blobsHashed += 1;
      const expected =
        parsed.algorithm === "sha512" ? hashed.sha512 : hashed.sha256;
      if (expected !== parsed.hex)
        recordFinding(
          findings,
          "digest_mismatch",
          `Blob ${digest} content does not match its digest.`,
          digest,
          path,
        );
      for (const declared of reference.declaredSizes)
        if (hashed.bytes !== declared)
          recordFinding(
            findings,
            "size_mismatch",
            `Blob ${digest} hashed ${String(hashed.bytes)} bytes; descriptor size is ${String(declared)}.`,
            digest,
            path,
          );
      blobs.push(
        blobRecord(
          digest,
          path,
          reference.mediaType,
          reference.declaredSize,
          true,
          "file",
          {
            present: true,
            hashed: true,
            sha256: hashed.sha256,
            sha512: hashed.sha512,
            observed_size: hashed.bytes,
          },
        ),
      );
    } catch (cause: unknown) {
      if (cause instanceof BlobOversize) {
        recordFinding(
          findings,
          "blob_oversize",
          `Blob ${digest} exceeds the ${String(cause.maximum)}-byte hash budget.`,
          digest,
          path,
        );
        blobs.push(
          blobRecord(
            digest,
            path,
            reference.mediaType,
            reference.declaredSize,
            true,
            "file",
            {
              present: true,
              hashed: false,
              observed_size: entry.declaredSize,
            },
          ),
        );
        continue;
      }
      throw cause;
    }
  }

  for (const entry of entries) {
    if (!entry.path.startsWith("blobs/") || entry.path === "blobs") continue;
    const parts = entry.path.split("/");
    if (parts.length !== 3) continue;
    const digest = `${parts[1]}:${parts[2]}`;
    if (referenced.has(digest)) continue;
    if (entry.kind === "directory") continue;
    recordFinding(
      findings,
      "unreferenced_blob",
      `Blob ${entry.path} is not referenced by the index, manifests, or configs.`,
      digest,
      entry.path,
    );
    blobs.push(
      blobRecord(
        digest,
        entry.path,
        null,
        entry.declaredSize,
        false,
        entry.kind === "symlink"
          ? "symlink"
          : entry.kind === "file"
            ? "file"
            : "other",
        {
          present: entry.kind === "file",
          observed_size: entry.declaredSize,
        },
      ),
    );
  }

  const snapshot = digestCanonicalValue(
    {
      layout_version: layoutVersion,
      oci_layout_digest: layoutDocument.sha256,
      index_digest: indexDocument.sha256,
    },
    "OCI image layout snapshot",
  );
  const coverageStatus =
    referencedJsonSkipped ||
    findings.some(
      (finding) =>
        finding.kind === "missing_blob" ||
        finding.kind === "nested_index_depth_exceeded" ||
        finding.kind === "blob_oversize" ||
        finding.kind === "malformed_blob_json",
    )
      ? ("partial" as const)
      : ("complete" as const);

  return {
    artifact: {
      path: input.path,
      format: "directory",
      snapshot_sha256: snapshot,
      layout_version: layoutVersion,
      oci_layout_digest: layoutDocument.sha256,
      index_digest: indexDocument.sha256,
    },
    indexes,
    images,
    blobs,
    findings,
    coverage: {
      status: coverageStatus,
      entries_examined: entries.length,
      blobs_hashed: blobsHashed,
      json_bytes_read: jsonBytesRead,
    },
    limitations,
  };
};
