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
  type ArtifactReaderTraversal,
  type ArtifactTraversalOmission,
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

/**
 * Why a descriptor's required size is unusable, or undefined when it is a
 * non-negative safe integer.
 */
const descriptorSizeDefect = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  const size = value.size;
  if (typeof size === "number" && Number.isSafeInteger(size) && size >= 0)
    return undefined;
  return size === undefined
    ? "lacks a size"
    : `size ${describeSizeValue(size)} is not a non-negative integer`;
};

/**
 * A bounded description of an unusable size member. The value is untrusted,
 * so containers and long strings are named by type and length, never
 * serialized.
 */
const describeSizeValue = (size: unknown): string => {
  if (typeof size === "number" || typeof size === "boolean")
    return String(size);
  if (size === null) return "null";
  if (typeof size === "string")
    return size.length <= 32
      ? JSON.stringify(size)
      : `(a ${String(size.length)}-character string)`;
  if (Array.isArray(size)) return `(an array of ${String(size.length)} items)`;
  return "(an object)";
};

/**
 * Why a descriptor's present platform or annotations cannot be modeled in
 * full. `descriptorOf` still keeps the readable parts; null counts as absent.
 */
const descriptorMetadataDefects = (value: unknown): string[] => {
  if (!isRecord(value)) return [];
  const defects: string[] = [];
  const { platform, annotations } = value;
  if (platform !== undefined && platform !== null) {
    if (!isRecord(platform))
      defects.push("platform is not a JSON object; it is not modeled");
    else {
      const bad = ["os", "architecture", "variant", "os.version"].filter(
        (name) =>
          platform[name] !== undefined &&
          platform[name] !== null &&
          typeof platform[name] !== "string",
      );
      if (bad.length > 0)
        defects.push(
          `platform ${bad.join(", ")} ${bad.length === 1 ? "is" : "are"} not a string; ${bad.length === 1 ? "it is" : "they are"} omitted`,
        );
    }
  }
  if (annotations !== undefined && annotations !== null) {
    if (!isRecord(annotations))
      defects.push("annotations is not a JSON object; it is not modeled");
    else {
      const dropped = Object.values(annotations).filter(
        (entry) => typeof entry !== "string",
      ).length;
      if (dropped > 0)
        defects.push(
          `annotations has ${String(dropped)} value${dropped === 1 ? "" : "s"} that ${dropped === 1 ? "is" : "are"} not a string; ${dropped === 1 ? "it is" : "they are"} omitted`,
        );
    }
  }
  return defects;
};

/** Untrusted digest text that `descriptorDefect` embeds for a rejected record. */
const rejectedDescriptorDigest = (value: unknown): string | null =>
  isRecord(value) ? nonempty(value.digest) : null;

/** What a descriptor that `descriptorOf` cannot model is missing. */
const descriptorDefect = (value: unknown): string => {
  if (!isRecord(value)) return "is not a JSON object";
  const digest = rejectedDescriptorDigest(value);
  const missing = [
    ...((nonempty(value.mediaType) ?? nonempty(value.media_type))
      ? []
      : ["a string mediaType"]),
    ...(digest !== null ? [] : ["a string digest"]),
  ];
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

/**
 * A bounded description of a repeated JSON member name. The name is untrusted
 * and can be as long as the blob, so a long one is named by length only.
 */
const describeMemberName = (name: string): string =>
  name.length <= 64
    ? JSON.stringify(name)
    : `(a ${String(name.length)}-character name)`;

interface JsonFileBytes {
  readonly content: Buffer;
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * Read and hash one JSON file through the reader, then hand its bytes to
 * `finish` inside the read. With an identity `finish`, the returned hash has
 * passed the reader's own checks, so a caller can keep it even when the bytes
 * later fail to decode.
 */
const readJsonFile = async <Value>(
  reader: DirectoryArtifactReader,
  entry: DirectoryArtifactEntry,
  maximum: number,
  signal: AbortSignal | undefined,
  label: string,
  finish: (file: JsonFileBytes) => Value,
): Promise<Value> => {
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
        const content = Buffer.concat(chunks);
        return finish({
          content,
          sha256: hash.digest("hex"),
          bytes: content.length,
        });
      },
      signal,
    );
  } catch (cause: unknown) {
    if (cause instanceof ParseFailureError) throw cause;
    // DirectoryArtifactReader.inspectFile wraps a callback failure as a plain
    // "io" error; reader-owned failures such as "integrity", "cancelled" or
    // "limit" (and any failure carrying cleanup) keep their reader facts.
    if (
      cause instanceof ArtifactReaderFailure &&
      cause.reason === "io" &&
      cause.cleanup === undefined &&
      cause.cause instanceof ParseFailureError
    )
      throw cause.cause;
    throw cause;
  }
};

/** Decode bytes `readJsonFile` admitted as strict UTF-8 JSON. */
const decodeJsonDocument = (
  file: JsonFileBytes,
  label: string,
): JsonDocument => {
  let text: string;
  try {
    text = decodeStrictUtf8(file.content, "strip-signature");
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
        `${label} repeats object member ${describeMemberName(parsed.duplicate.name)}.`,
      );
    throw malformedInput(
      OCI_IMAGE_LAYOUT_FORMAT,
      `${label} is not valid JSON.`,
      { cause: parsed.cause },
    );
  }
  return { value: parsed.value, sha256: file.sha256, bytes: file.bytes };
};

const readJsonDocument = async (
  reader: DirectoryArtifactReader,
  entry: DirectoryArtifactEntry,
  maximum: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<JsonDocument> =>
  readJsonFile(reader, entry, maximum, signal, label, (file) =>
    decodeJsonDocument(file, label),
  );

interface ReferencedBlob {
  digest: string;
  mediaType: string | null;
  declaredSize: number | null;
  /** Every distinct size the descriptors referencing this blob declared, in declaration order. */
  declaredSizes: number[];
  /** Membership index for declaredSizes, so many shared references stay linear. */
  declaredSizeSet: Set<number>;
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
  defects: string[],
): OciImageLayoutImage["env"] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    defects.push("config.Env is not an array; it is not modeled");
    return [];
  }
  const bindings: OciImageLayoutImage["env"] = [];
  let invalid = 0;
  let first = -1;
  for (const [position, item] of value.entries()) {
    const separator = typeof item === "string" ? item.indexOf("=") : -1;
    const name =
      typeof item !== "string"
        ? ""
        : separator === -1
          ? item
          : item.slice(0, separator);
    if (typeof item !== "string" || name.length === 0) {
      invalid += 1;
      if (first === -1) first = position;
      continue;
    }
    bindings.push({
      name,
      value:
        includeValues && separator !== -1 ? item.slice(separator + 1) : null,
    });
  }
  if (invalid > 0)
    defects.push(
      `config.Env has ${String(invalid)} member${invalid === 1 ? "" : "s"} that ${invalid === 1 ? "is" : "are"} not a named string, first at [${String(first)}]; ${invalid === 1 ? "it is" : "they are"} omitted`,
    );
  return bindings;
};

const HISTORY_FIELDS = [
  ["created", "string"],
  ["created_by", "string"],
  ["createdBy", "string"],
  ["empty_layer", "boolean"],
  ["emptyLayer", "boolean"],
  ["comment", "string"],
] as const;

const historyRecordOf = (
  item: Record<string, unknown>,
): OciImageLayoutImage["history"][number] => ({
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

const historyOf = (
  value: unknown,
  defects: string[],
): OciImageLayoutImage["history"] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    defects.push("history is not an array; it is not modeled");
    return [];
  }
  const history: OciImageLayoutImage["history"] = [];
  let invalid = 0;
  let first = -1;
  const fieldDefects = new Map<
    (typeof HISTORY_FIELDS)[number][0],
    { count: number; first: number }
  >();
  for (const [position, item] of value.entries()) {
    if (!isRecord(item)) {
      invalid += 1;
      if (first === -1) first = position;
      continue;
    }
    for (const [name, expected] of HISTORY_FIELDS) {
      const member = item[name];
      if (
        member !== undefined &&
        member !== null &&
        typeof member !== expected
      ) {
        const current = fieldDefects.get(name);
        if (current === undefined)
          fieldDefects.set(name, { count: 1, first: position });
        else current.count += 1;
      }
    }
    history.push(historyRecordOf(item));
  }
  if (invalid > 0)
    defects.push(
      `history has ${String(invalid)} member${invalid === 1 ? "" : "s"} that ${invalid === 1 ? "is" : "are"} not a JSON object, first at [${String(first)}]; ${invalid === 1 ? "it is" : "they are"} omitted`,
    );
  for (const [name, expected] of HISTORY_FIELDS) {
    const defect = fieldDefects.get(name);
    if (defect === undefined) continue;
    defects.push(
      `history has ${String(defect.count)} member${defect.count === 1 ? "" : "s"} whose ${name} is not a ${expected}, first at [${String(defect.first)}]; ${defect.count === 1 ? "it is" : "they are"} not modeled`,
    );
  }
  return history;
};

type ConfigFacts = Pick<
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
>;

const EMPTY_CONFIG_FACTS: ConfigFacts = {
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

/**
 * Keys of a config set such as ExposedPorts. An empty key names nothing, so
 * it is omitted and reported as a defect instead of becoming an empty fact.
 */
const configKeys = (
  value: unknown,
  label: string,
  defects: string[],
): string[] => {
  if (value !== undefined && value !== null && !isRecord(value))
    defects.push(`${label} is not a JSON object; it is not modeled`);
  const keys = objectKeys(value);
  const named = keys.filter((key) => key !== "");
  if (named.length !== keys.length)
    defects.push(`${label} has an empty key; it is omitted`);
  return named;
};

/**
 * rootfs.diff_ids as nonempty strings. Members that are not are omitted and
 * reported, so a damaged config keeps its other facts.
 */
const diffIdsOf = (rootfs: Record<string, unknown>, defects: string[]) => {
  const value = rootfs.diff_ids;
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    defects.push("rootfs.diff_ids is not an array; it is not modeled");
    return [];
  }
  const diffIds: string[] = [];
  let invalid = 0;
  let first = -1;
  for (const [position, item] of value.entries()) {
    if (typeof item === "string" && item !== "") {
      diffIds.push(item);
      continue;
    }
    invalid += 1;
    if (first === -1) first = position;
  }
  if (invalid > 0)
    defects.push(
      `rootfs.diff_ids has ${String(invalid)} member${invalid === 1 ? "" : "s"} that ${invalid === 1 ? "is" : "are"} not a nonempty string, first at [${String(first)}]; ${invalid === 1 ? "it is" : "they are"} omitted`,
    );
  return diffIds;
};

const configSubobject = (
  value: unknown,
  defect: string,
  defects: string[],
): Record<string, unknown> => {
  if (value === undefined) return {};
  if (isRecord(value)) return value;
  defects.push(defect);
  return {};
};

/**
 * A string config field. A present value of another type is reported rather
 * than read as an omitted declaration; null is treated as omitted.
 */
const stringField = (
  value: unknown,
  label: string,
  defects: string[],
): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    defects.push(`${label} is not a string; it is not modeled`);
    return null;
  }
  return nonempty(value);
};

/** A string-array config field such as Cmd, reported when malformed. */
const stringArrayField = (
  value: unknown,
  label: string,
  defects: string[],
): string[] | null => {
  if (value === undefined || value === null) return null;
  const items = asStringArray(value);
  if (items === null)
    defects.push(`${label} is not an array of strings; it is not modeled`);
  return items;
};

/** Config labels, with a defect for a non-object or non-string values. */
const labelsField = (
  value: unknown,
  defects: string[],
): { name: string; value: string }[] => {
  if (value === undefined || value === null) return [];
  if (!isRecord(value)) {
    defects.push("config.Labels is not a JSON object; it is not modeled");
    return [];
  }
  const labels = annotationsOf(value);
  const dropped = Object.keys(value).length - labels.length;
  if (dropped > 0)
    defects.push(
      `config.Labels has ${String(dropped)} value${dropped === 1 ? "" : "s"} that ${dropped === 1 ? "is" : "are"} not a string; ${dropped === 1 ? "it is" : "they are"} omitted`,
    );
  return labels;
};

/**
 * Image facts from one config document, with the defects that left any of
 * them out. Defects are reported once per config blob by the caller.
 */
const parseConfig = (
  value: unknown,
  includeEnvValues: boolean,
): { facts: ConfigFacts; defects: string[] } => {
  if (!isRecord(value)) return { facts: EMPTY_CONFIG_FACTS, defects: [] };
  const defects: string[] = [];
  const config = configSubobject(
    value.config,
    "config is not a JSON object; its runtime facts are not modeled",
    defects,
  );
  const rootfs = configSubobject(
    value.rootfs,
    "rootfs is not a JSON object; its diff IDs are not modeled",
    defects,
  );
  return {
    facts: {
      architecture: stringField(value.architecture, "architecture", defects),
      os: stringField(value.os, "os", defects),
      variant: stringField(value.variant, "variant", defects),
      created: stringField(value.created, "created", defects),
      author: stringField(value.author, "author", defects),
      user: stringField(config.User ?? config.user, "config.User", defects),
      env: envBindings(config.Env ?? config.env, includeEnvValues, defects),
      entrypoint: stringArrayField(
        config.Entrypoint ?? config.entrypoint,
        "config.Entrypoint",
        defects,
      ),
      cmd: stringArrayField(config.Cmd ?? config.cmd, "config.Cmd", defects),
      working_dir: stringField(
        config.WorkingDir ?? config.workingDir,
        "config.WorkingDir",
        defects,
      ),
      exposed_ports: configKeys(
        config.ExposedPorts ?? config.exposedPorts,
        "config.ExposedPorts",
        defects,
      ),
      volumes: configKeys(
        config.Volumes ?? config.volumes,
        "config.Volumes",
        defects,
      ),
      labels: labelsField(config.Labels ?? config.labels, defects),
      stop_signal: stringField(
        config.StopSignal ?? config.stopSignal,
        "config.StopSignal",
        defects,
      ),
      rootfs_diff_ids: diffIdsOf(rootfs, defects),
      history: historyOf(value.history, defects),
    },
    defects,
  };
};

/** OCI's `algorithm:encoded` grammar, for digests this parser cannot verify. */
const OCI_DIGEST_GRAMMAR =
  /^([a-z0-9]+(?:[+._-][a-z0-9]+)*):([a-zA-Z0-9=_-]+)$/u;

/** Where the layout stores a blob whose digest algorithm is unsupported. */
const unverifiedBlobPath = (digest: string): string | undefined => {
  const match = OCI_DIGEST_GRAMMAR.exec(digest);
  return match === null ? undefined : `blobs/${match[1]!}/${match[2]!}`;
};

const blobRecord = (
  digest: string,
  path: string,
  mediaType: string | null,
  declaredSize: number | null,
  referenced: boolean | null,
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
  const observed: { layout?: FileSnapshotPartialObservation } = {};
  try {
    return await inventoryOciImageLayout(reader, input, observed, signal);
  } catch (cause: unknown) {
    // A refusal after oci-layout was hashed, such as a later manifest, config
    // or descriptor budget, keeps that completed observation.
    if (
      cause instanceof ParseFailureError &&
      !(cause instanceof OciImageLayoutRefusal) &&
      observed.layout !== undefined
    )
      refuse(cause.failure, observed.layout, cause);
    // A reader failure after that point, such as an unreadable blob, keeps
    // the observation too unless the reader already attached its own.
    if (
      cause instanceof ArtifactReaderFailure &&
      cause.partialObservation === undefined &&
      observed.layout !== undefined
    )
      cause.partialObservation = observed.layout;
    throw cause;
  }
};

const inventoryOciImageLayout = async (
  reader: DirectoryArtifactReader,
  input: InspectOciImageLayoutInput,
  observed: { layout?: FileSnapshotPartialObservation },
  signal?: AbortSignal,
): Promise<OciImageLayout> => {
  const findings: OciImageLayoutFinding[] = [];
  const limitations: string[] = [...BASE_LIMITATIONS];
  if (!input.include_env_values)
    limitations.push(OCI_IMAGE_LAYOUT_LIMITATIONS.envRedacted);

  const entries: DirectoryArtifactEntry[] = [];
  // Silence from the reader is not a completeness claim.
  const traversal: { current: ArtifactReaderTraversal } = {
    current: {
      status: "unknown",
      limitations: ["Directory traversal did not report its coverage."],
    },
  };
  // Directories outside blobs/ are skipped on purpose; any other omission is
  // an entry the inventory cannot account for.
  const omitted: ArtifactTraversalOmission[] = [];
  try {
    for await (const entry of reader.entries(signal, {
      maximumEntries: input.max_entries,
      descendInto: (path) => path === "blobs" || path.startsWith("blobs/"),
      onCoverage: (coverage) => {
        traversal.current = coverage;
      },
      onOmission: (omission) => {
        if (omission.kind !== "directory-descendants") omitted.push(omission);
      },
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
  if (omitted.length > 0)
    traversal.current = {
      status: "unknown",
      limitations: [
        ...traversal.current.limitations,
        `Directory traversal omitted ${String(omitted.length)} entr${omitted.length === 1 ? "y" : "ies"} that are not regular files, directories, or symlinks; they are absent from the blob inventory. First omitted: ${omitted[0]?.path ?? "unknown"} (${omitted[0]?.kind ?? "unknown"}).`,
      ],
    };
  for (const limitation of traversal.current.limitations)
    if (!limitations.includes(limitation)) limitations.push(limitation);

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
  const layoutFile = await readJsonFile(
    reader,
    layoutEntry,
    input.max_json_bytes,
    signal,
    "oci-layout",
    (file) => file,
  );
  // The completed hash is kept before decoding, so a malformed oci-layout
  // refusal still carries the file identity the reader admitted.
  const layoutObservation: FileSnapshotPartialObservation = {
    kind: "file-snapshot-hash",
    path: "oci-layout",
    sha256: layoutFile.sha256,
    bytes: layoutFile.bytes,
  };
  observed.layout = layoutObservation;
  const layoutDocument = decodeJsonDocument(layoutFile, "oci-layout");
  const layoutVersion = isRecord(layoutDocument.value)
    ? nonempty(layoutDocument.value.imageLayoutVersion)
    : null;
  if (layoutVersion === null)
    throw new OciImageLayoutRefusal(
      malformedInput(
        OCI_IMAGE_LAYOUT_FORMAT,
        "oci-layout is missing imageLayoutVersion.",
      ).failure,
      layoutObservation,
    );
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
  // manifests is required; a wrong-typed member is a damaged index, not an
  // empty one.
  if (!Array.isArray(indexDocument.value.manifests)) {
    throw new OciImageLayoutRefusal(
      malformedInput(
        OCI_IMAGE_LAYOUT_FORMAT,
        "index.json manifests is not an array.",
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
        declaredSizeSet: new Set(declaredSize === null ? [] : [declaredSize]),
      });
      return;
    }
    if (existing.mediaType === null && mediaType !== null)
      existing.mediaType = mediaType;
    if (declaredSize === null || existing.declaredSizeSet.has(declaredSize))
      return;
    existing.declaredSize ??= declaredSize;
    existing.declaredSizes.push(declaredSize);
    existing.declaredSizeSet.add(declaredSize);
  };

  // A descriptor whose required size is unusable keeps its other facts, but
  // its blob cannot be size-checked against that declaration, so the defect
  // is reported instead of disappearing into a null size.
  const reportDescriptorDefects = (
    where: string,
    value: unknown,
    ownerDigest: string,
  ): void => {
    const defect = descriptorSizeDefect(value);
    if (defect !== undefined)
      recordFinding(
        findings,
        "malformed_blob_json",
        `${where} ${defect}; its declared size is not checked.`,
        ownerDigest,
      );
    // Damaged platform or annotations are reported rather than read as
    // absent; the readable entries stay on the descriptor.
    for (const metadataDefect of descriptorMetadataDefects(value))
      recordFinding(
        findings,
        "malformed_blob_json",
        `${where} ${metadataDefect}.`,
        ownerDigest,
      );
  };

  const indexes: OciImageLayoutIndex[] = [];
  const images: OciImageLayoutImage[] = [];
  // Traversal is keyed by the resolved blob path, so descriptors whose
  // digests differ only in accepted hex casing read and walk one blob once
  // while each keeps its source spelling in the report.
  // A spelling that does not parse keeps its own namespace, so text such as
  // "blobs/sha256/<hex>" never collides with the accepted digest's key.
  const traversalKey = (digest: string): string => {
    const parsed = parseOciDigest(digest);
    return parsed === undefined
      ? `raw:${digest}`
      : `blob:${ociBlobPath(parsed)}`;
  };
  const visited = new Set<string>();
  // Decoded descriptors have their own allowance: max_entries bounds the
  // directory walk, and a shared layer is a single file but one descriptor
  // in every manifest that references it.
  let descriptorsDecoded = 0;
  const chargeDescriptor = (): void => {
    descriptorsDecoded += 1;
    if (descriptorsDecoded > input.max_descriptors)
      throw decodeLimit(
        OCI_IMAGE_LAYOUT_FORMAT,
        `OCI image layout exceeds the ${String(input.max_descriptors)}-descriptor budget.`,
        {
          name: "max_descriptors",
          maximum: input.max_descriptors,
          required: descriptorsDecoded,
        },
      );
  };

  // Each config blob is read and parsed once; images sharing it reuse those
  // facts. Every image still carries its own copy of them in the report, so
  // the config bytes behind each image spend max_config_bytes before the
  // image is added.
  const configs = new Map<
    string,
    { facts: ConfigFacts; bytes: number } | undefined
  >();
  let configBytesExpanded = 0;
  const chargeConfigBytes = (bytes: number): void => {
    configBytesExpanded += bytes;
    if (configBytesExpanded > input.max_config_bytes)
      throw decodeLimit(
        OCI_IMAGE_LAYOUT_FORMAT,
        `OCI image layout config facts exceed the ${String(input.max_config_bytes)}-byte budget.`,
        {
          name: "max_config_bytes",
          maximum: input.max_config_bytes,
          required: configBytesExpanded,
        },
      );
  };

  // Index entries keep their text, annotations included, in the report;
  // accepted subjects, configs and layers keep their digest and media type in
  // image rows, the reference map, findings and blob rows; and rejected
  // descriptors embed their untrusted digest in findings. All of that text
  // spends max_descriptor_bytes before being retained.
  let descriptorBytesRetained = 0;
  const spendDescriptorBytes = (bytes: number): void => {
    descriptorBytesRetained += bytes;
    if (descriptorBytesRetained > input.max_descriptor_bytes)
      throw decodeLimit(
        OCI_IMAGE_LAYOUT_FORMAT,
        `OCI image layout retained descriptor text exceeds the ${String(input.max_descriptor_bytes)}-byte budget.`,
        {
          name: "max_descriptor_bytes",
          maximum: input.max_descriptor_bytes,
          required: descriptorBytesRetained,
        },
      );
  };
  const chargeDescriptorBytes = (
    descriptor: OciImageLayoutIndex["entries"][number],
  ): void => {
    let bytes =
      Buffer.byteLength(descriptor.digest) +
      Buffer.byteLength(descriptor.media_type);
    for (const text of Object.values(descriptor.platform ?? {}))
      if (text !== null) bytes += Buffer.byteLength(text);
    for (const annotation of descriptor.annotations)
      bytes +=
        Buffer.byteLength(annotation.name) +
        Buffer.byteLength(annotation.value);
    spendDescriptorBytes(bytes);
  };
  const chargeAcceptedDescriptorText = (descriptor: {
    digest: string;
    media_type: string;
  }): void => {
    spendDescriptorBytes(
      Buffer.byteLength(descriptor.digest) +
        Buffer.byteLength(descriptor.media_type),
    );
  };
  const chargeRejectedDescriptorText = (value: unknown): void => {
    const digest = rejectedDescriptorDigest(value);
    if (digest !== null) spendDescriptorBytes(Buffer.byteLength(digest));
  };

  // A referenced index, manifest or config that could not be read leaves its
  // facts unexamined, whatever finding explains why.
  let referencedJsonSkipped = false;
  // An index or manifest left unexamined may reference any blob, so the
  // walk no longer proves which blobs nothing references.
  let referenceGraphTruncated = false;
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
      // Only a format failure is a finding about the blob. Reader failures,
      // including a close failure after a complete read, keep their own
      // facts and reach the caller.
      if (!(cause instanceof ParseFailureError) || cause.kind === "limit")
        throw cause;
      recordFinding(
        findings,
        "malformed_blob_json",
        cause.failure.detail,
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
  const enqueueIndex = (
    digest: string,
    mediaType: string,
    depth: number,
  ): void => {
    // Breadth-first, an index already queued was reached at this depth or a
    // shallower one.
    if (queuedIndexes.has(traversalKey(digest))) return;
    if (depth > input.max_index_depth) {
      referenceGraphTruncated = true;
      recordFinding(
        findings,
        "nested_index_depth_exceeded",
        `Nested index ${digest} exceeds max_index_depth ${String(input.max_index_depth)}.`,
        digest,
      );
      return;
    }
    queuedIndexes.add(traversalKey(digest));
    indexQueue.push({ digest, mediaType, depth });
  };

  // An OCI 1.1 subject names the manifest an index or manifest refers to.
  // The subject may legitimately be absent from the layout, so only a
  // subject blob present at its layout path joins the referenced set, where
  // it is hashed and no longer reported as unreferenced. A present subject
  // manifest is queued and walked after its owner finishes, and a present
  // subject index goes through the breadth-first queue one level below its
  // owner, so the blobs it names are not reported as unreferenced either. A
  // present subject with an unfamiliar media type is still reported as
  // unknown.
  const rememberSubject = async (
    owner: string,
    ownerDigest: string,
    value: unknown,
    ownerDepth: number,
  ): Promise<void> => {
    if (value === undefined) return;
    chargeDescriptor();
    const descriptor = descriptorOf(value);
    if (descriptor === undefined) {
      referenceGraphTruncated = true;
      chargeRejectedDescriptorText(value);
      recordFinding(
        findings,
        "malformed_blob_json",
        `${owner} ${ownerDigest} subject ${descriptorDefect(value)}; the subject is not modeled.`,
        ownerDigest,
      );
      return;
    }
    chargeAcceptedDescriptorText(descriptor);
    reportDescriptorDefects(
      `${owner} ${ownerDigest} subject`,
      value,
      ownerDigest,
    );
    const parsed = parseOciDigest(descriptor.digest);
    const path =
      parsed === undefined
        ? unverifiedBlobPath(descriptor.digest)
        : ociBlobPath(parsed);
    if (path === undefined || !byPath.has(path)) return;
    remember(descriptor.digest, descriptor.media_type, descriptor.size);
    if (!isOciKnownMediaType(descriptor.media_type)) {
      recordFinding(
        findings,
        "unknown_media_type",
        `${owner} ${ownerDigest} subject media type ${JSON.stringify(descriptor.media_type)} is unknown.`,
        descriptor.digest,
      );
      return;
    }
    // A digest this parser cannot verify is not read; the blob pass reports
    // the unsupported algorithm.
    if (parsed === undefined) return;
    if (isOciIndexMediaType(descriptor.media_type))
      enqueueIndex(descriptor.digest, descriptor.media_type, ownerDepth + 1);
    else if (isOciManifestMediaType(descriptor.media_type))
      await walkManifest(descriptor.digest, descriptor.media_type, ownerDepth);
  };

  const walkIndex = async (
    digest: string,
    mediaType: string,
    document: JsonDocument,
    depth: number,
  ): Promise<void> => {
    if (visited.has(traversalKey(digest))) return;
    visited.add(traversalKey(digest));
    chargeDescriptor();
    if (depth > input.max_index_depth) {
      referenceGraphTruncated = true;
      recordFinding(
        findings,
        "nested_index_depth_exceeded",
        `Nested index ${digest} exceeds max_index_depth ${String(input.max_index_depth)}.`,
        digest,
      );
      return;
    }
    if (!isRecord(document.value)) {
      referenceGraphTruncated = true;
      recordFinding(
        findings,
        "malformed_blob_json",
        `Index ${digest} root is not a JSON object.`,
        digest,
      );
      return;
    }
    await rememberSubject("Index", digest, document.value.subject, depth);
    const schemaVersion =
      typeof document.value.schemaVersion === "number" &&
      Number.isSafeInteger(document.value.schemaVersion)
        ? document.value.schemaVersion
        : null;
    let manifests: unknown[] = [];
    if (Array.isArray(document.value.manifests))
      manifests = document.value.manifests;
    else {
      referenceGraphTruncated = true;
      recordFinding(
        findings,
        "malformed_blob_json",
        `Index ${digest} manifests is not an array; its entries are not modeled.`,
        digest,
      );
    }
    const indexEntries: OciImageLayoutIndex["entries"] = [];
    for (const [position, item] of manifests.entries()) {
      chargeDescriptor();
      const descriptor = descriptorOf(item);
      if (descriptor === undefined) {
        referenceGraphTruncated = true;
        chargeRejectedDescriptorText(item);
        recordFinding(
          findings,
          "malformed_blob_json",
          `Index ${digest} manifests[${String(position)}] ${descriptorDefect(item)}; the entry is not modeled.`,
          digest,
        );
        continue;
      }
      chargeDescriptorBytes(descriptor);
      indexEntries.push(descriptor);
      reportDescriptorDefects(
        `Index ${digest} manifests[${String(position)}]`,
        item,
        digest,
      );
      remember(descriptor.digest, descriptor.media_type, descriptor.size);
      if (!isOciKnownMediaType(descriptor.media_type)) {
        // An opaque entry is not walked, so whatever it references is
        // unknown and no blob can be called unreferenced.
        referenceGraphTruncated = true;
        recordFinding(
          findings,
          "unknown_media_type",
          `Descriptor media type ${JSON.stringify(descriptor.media_type)} is unknown.`,
          descriptor.digest,
        );
      }
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
      if (isOciIndexMediaType(descriptor.media_type))
        enqueueIndex(descriptor.digest, descriptor.media_type, depth + 1);
      else if (isOciManifestMediaType(descriptor.media_type))
        await walkManifest(descriptor.digest, descriptor.media_type, depth);
    }
  };

  // Manifests are drained iteratively so a chain of local subject links
  // finishes each owner (charging its config bytes, recording its image, and
  // dropping its parsed JSON document) before reading the next manifest.
  const manifestQueue: { digest: string; mediaType: string; depth: number }[] =
    [];
  let drainingManifests = false;

  /** `depth` is that of the index whose walk reached this manifest. */
  const walkOneManifest = async (
    digest: string,
    mediaType: string,
    depth: number,
  ): Promise<void> => {
    if (visited.has(`manifest:${traversalKey(digest)}`)) return;
    visited.add(`manifest:${traversalKey(digest)}`);
    chargeDescriptor();
    const document = await readReferencedJson(digest, `manifest ${digest}`);
    if (document === undefined) {
      referenceGraphTruncated = true;
      return;
    }
    if (!isRecord(document.value)) {
      referenceGraphTruncated = true;
      recordFinding(
        findings,
        "malformed_blob_json",
        `Manifest ${digest} root is not a JSON object.`,
        digest,
      );
      return;
    }
    await rememberSubject("Manifest", digest, document.value.subject, depth);
    // config is required; a manifest without one is as damaged as one whose
    // config descriptor cannot be modeled.
    const configDescriptor = descriptorOf(document.value.config);
    if (configDescriptor === undefined) {
      referenceGraphTruncated = true;
      chargeRejectedDescriptorText(document.value.config);
      recordFinding(
        findings,
        "malformed_blob_json",
        document.value.config === undefined
          ? `Manifest ${digest} lacks a config descriptor; the config is not modeled.`
          : `Manifest ${digest} config ${descriptorDefect(document.value.config)}; the config is not modeled.`,
        digest,
      );
    }
    const layers: OciImageLayoutImage["layers"] = [];
    let layerItems: unknown[] = [];
    if (Array.isArray(document.value.layers))
      layerItems = document.value.layers;
    else {
      referenceGraphTruncated = true;
      recordFinding(
        findings,
        "malformed_blob_json",
        `Manifest ${digest} layers is not an array; its layers are not modeled.`,
        digest,
      );
    }
    for (const [position, item] of layerItems.entries()) {
      chargeDescriptor();
      const descriptor = descriptorOf(item);
      if (descriptor === undefined) {
        referenceGraphTruncated = true;
        chargeRejectedDescriptorText(item);
        recordFinding(
          findings,
          "malformed_blob_json",
          `Manifest ${digest} layers[${String(position)}] ${descriptorDefect(item)}; the layer is not modeled.`,
          digest,
        );
        continue;
      }
      chargeAcceptedDescriptorText(descriptor);
      reportDescriptorDefects(
        `Manifest ${digest} layers[${String(position)}]`,
        item,
        digest,
      );
      remember(descriptor.digest, descriptor.media_type, descriptor.size);
      if (!isOciKnownMediaType(descriptor.media_type))
        recordFinding(
          findings,
          "unknown_media_type",
          `Layer media type ${JSON.stringify(descriptor.media_type)} is unknown.`,
          descriptor.digest,
        );
      // Presence is observed at the layout path even when the digest
      // algorithm cannot be verified, matching the blob inventory.
      const parsed = parseOciDigest(descriptor.digest);
      const path =
        parsed === undefined
          ? unverifiedBlobPath(descriptor.digest)
          : ociBlobPath(parsed);
      const entry = path === undefined ? undefined : byPath.get(path);
      layers.push({
        media_type: descriptor.media_type,
        digest: descriptor.digest,
        size: descriptor.size,
        present: entry?.kind === "file",
      });
    }
    let configFacts = EMPTY_CONFIG_FACTS;
    if (configDescriptor !== undefined) {
      chargeAcceptedDescriptorText(configDescriptor);
      reportDescriptorDefects(
        `Manifest ${digest} config`,
        document.value.config,
        digest,
      );
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
      // Only image config media types are decoded as JSON. Any other config,
      // such as an artifact's application/octet-stream blob, stays an opaque
      // reference that the blob pass still hashes.
      const decodeConfig =
        configDescriptor.media_type !== null &&
        isOciConfigMediaType(configDescriptor.media_type);
      const configKey = traversalKey(configDescriptor.digest);
      let config = decodeConfig ? configs.get(configKey) : undefined;
      if (decodeConfig && !configs.has(configKey)) {
        const configDocument = await readReferencedJson(
          configDescriptor.digest,
          `config ${configDescriptor.digest}`,
        );
        if (configDocument !== undefined && !isRecord(configDocument.value))
          recordFinding(
            findings,
            "malformed_blob_json",
            `Config ${configDescriptor.digest} root is not a JSON object; its facts are not modeled.`,
            configDescriptor.digest,
          );
        if (configDocument === undefined) config = undefined;
        else {
          const parsedConfig = parseConfig(
            configDocument.value,
            input.include_env_values,
          );
          // A defective member is omitted from the facts rather than
          // failing the whole inventory, and the config is reported once.
          for (const defect of parsedConfig.defects)
            recordFinding(
              findings,
              "malformed_blob_json",
              `Config ${configDescriptor.digest} ${defect}.`,
              configDescriptor.digest,
            );
          config = { facts: parsedConfig.facts, bytes: configDocument.bytes };
        }
        configs.set(configKey, config);
      }
      if (config !== undefined) {
        chargeConfigBytes(config.bytes);
        configFacts = config.facts;
      }
    }
    images.push({
      digest,
      media_type: mediaType,
      config_digest: configDescriptor?.digest ?? null,
      ...configFacts,
      layers,
    });
  };

  const walkManifest = async (
    digest: string,
    mediaType: string,
    depth: number,
  ): Promise<void> => {
    manifestQueue.push({ digest, mediaType, depth });
    if (drainingManifests) return;
    drainingManifests = true;
    try {
      for (
        let next = manifestQueue.shift();
        next !== undefined;
        next = manifestQueue.shift()
      )
        await walkOneManifest(next.digest, next.mediaType, next.depth);
    } finally {
      manifestQueue.length = 0;
      drainingManifests = false;
    }
  };

  const topMediaType =
    nonempty(indexRoot.mediaType) ??
    nonempty(indexRoot.media_type) ??
    "application/vnd.oci.image.index.v1+json";
  const rootDigest = `sha256:${indexDocument.sha256}`;
  queuedIndexes.add(traversalKey(rootDigest));
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
    if (nested === undefined) referenceGraphTruncated = true;
    else await walkIndex(next.digest, next.mediaType, nested, next.depth);
  }

  const blobs: OciImageLayoutBlob[] = [];
  let blobsHashed = 0;
  // Reference membership is by resolved blob path: a descriptor spelling
  // such as uppercase hex resolves to the same file as its canonical form.
  const referencedPaths = new Set<string>();
  // Per-blob findings may already have been emitted while walking the
  // reference graph; index them once so each check is constant time.
  const findingKey = (kind: OciImageLayoutFinding["kind"], digest: string) =>
    `${kind}\u0000${digest}`;
  const emittedFindings = new Set(
    findings.flatMap((finding) =>
      finding.digest === null ? [] : [findingKey(finding.kind, finding.digest)],
    ),
  );
  const recordFindingOnce = (
    kind: OciImageLayoutFinding["kind"],
    message: string,
    digest: string,
    path: string | null = null,
  ): void => {
    const key = findingKey(kind, digest);
    if (emittedFindings.has(key)) return;
    emittedFindings.add(key);
    recordFinding(findings, kind, message, digest, path);
  };

  const checkDeclaredSizes = (
    digest: string,
    path: string,
    entry: DirectoryArtifactEntry,
    declaredSizes: readonly number[],
  ): void => {
    if (entry.declaredSize === null) return;
    for (const declared of declaredSizes)
      if (declared !== entry.declaredSize)
        recordFinding(
          findings,
          "size_mismatch",
          `Blob ${digest} declared size ${String(declared)} disagrees with file size ${String(entry.declaredSize)}.`,
          digest,
          path,
        );
  };

  // Digest spellings that differ only in accepted hex casing resolve to one
  // file, so each file is hashed once and every spelling reuses the result,
  // including an oversize refusal, with its own row and checks.
  const hashedByPath = new Map<
    string,
    Awaited<ReturnType<typeof hashBlob>> | BlobOversize
  >();
  for (const [digest, reference] of referenced) {
    const parsed = parseOciDigest(digest);
    if (parsed === undefined) {
      // The blob cannot be hashed, but its presence and file size are still
      // observable at the path the layout gives every digest.
      recordFindingOnce(
        "unsupported_digest_algorithm",
        `Digest ${digest} uses an unsupported algorithm.`,
        digest,
      );
      const path = unverifiedBlobPath(digest);
      if (path !== undefined) referencedPaths.add(path);
      const entry = path === undefined ? undefined : byPath.get(path);
      if (path !== undefined) {
        // Presence defects are independent of whether the digest can be
        // verified, so they get the same findings a supported digest gets.
        if (entry === undefined)
          recordFindingOnce(
            "missing_blob",
            `Referenced blob ${digest} is missing.`,
            digest,
            path,
          );
        else if (entry.kind === "symlink")
          recordFindingOnce(
            "symlink_blob",
            `Blob ${digest} is a symlink and was not followed.`,
            digest,
            path,
          );
        else if (entry.kind !== "file")
          recordFindingOnce(
            "missing_blob",
            `Referenced blob ${digest} is not a regular file.`,
            digest,
            path,
          );
        else checkDeclaredSizes(digest, path, entry, reference.declaredSizes);
      }
      blobs.push(
        blobRecord(
          digest,
          path ?? digest,
          reference.mediaType,
          reference.declaredSize,
          true,
          entry === undefined
            ? "missing"
            : entry.kind === "file"
              ? "file"
              : entry.kind === "symlink"
                ? "symlink"
                : "other",
          {
            present: entry?.kind === "file",
            observed_size: entry?.kind === "file" ? entry.declaredSize : null,
          },
        ),
      );
      continue;
    }
    const path = ociBlobPath(parsed);
    referencedPaths.add(path);
    const entry = byPath.get(path);
    if (entry === undefined) {
      recordFindingOnce(
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
      recordFindingOnce(
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
      recordFindingOnce(
        "missing_blob",
        `Referenced blob ${digest} is not a regular file.`,
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
          "other",
          { present: false },
        ),
      );
      continue;
    }
    // Each reference's declaration is checked against the one file.
    checkDeclaredSizes(digest, path, entry, reference.declaredSizes);
    try {
      let hashed = hashedByPath.get(path);
      if (hashed === undefined) {
        try {
          hashed = await hashBlob(
            reader,
            entry,
            input,
            signal,
            parsed.algorithm,
          );
          blobsHashed += 1;
        } catch (cause: unknown) {
          if (!(cause instanceof BlobOversize)) throw cause;
          hashed = cause;
        }
        hashedByPath.set(path, hashed);
      }
      if (hashed instanceof BlobOversize) throw hashed;
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

  // Unreferenced status is only definite once the whole reference graph was
  // examined; otherwise blobs outside the walked part keep their inventory
  // row with an unknown referenced status.
  if (referenceGraphTruncated)
    limitations.push(
      "The reference graph was not fully examined, so blobs it did not reach are listed with an unknown referenced status instead of being reported as unreferenced.",
    );
  // A symlink at blobs or blobs/<algorithm> is not followed, so whatever it
  // points at is unexamined, not absent, and the inventory cannot be complete.
  for (const entry of entries) {
    if (entry.kind !== "symlink") continue;
    if (
      entry.path !== "blobs" &&
      !(entry.path.startsWith("blobs/") && entry.path.split("/").length === 2)
    )
      continue;
    recordFinding(
      findings,
      "symlink_blob",
      `Blob directory ${entry.path} is a symlink and was not followed; blobs under it are not inventoried.`,
      null,
      entry.path,
    );
  }
  for (const entry of entries) {
    if (!entry.path.startsWith("blobs/") || entry.path === "blobs") continue;
    const parts = entry.path.split("/");
    if (parts.length !== 3) continue;
    const digest = `${parts[1]}:${parts[2]}`;
    if (referenced.has(digest) || referencedPaths.has(entry.path)) continue;
    if (entry.kind === "directory") continue;
    if (!referenceGraphTruncated)
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
        referenceGraphTruncated ? null : false,
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
  const findingsStatus =
    referencedJsonSkipped ||
    referenceGraphTruncated ||
    findings.some(
      (finding) =>
        finding.kind === "missing_blob" ||
        finding.kind === "symlink_blob" ||
        finding.kind === "unsupported_digest_algorithm" ||
        finding.kind === "nested_index_depth_exceeded" ||
        finding.kind === "blob_oversize" ||
        finding.kind === "malformed_blob_json",
    )
      ? ("partial" as const)
      : ("complete" as const);
  const traversalStatus = traversal.current.status;
  const coverageStatus =
    traversalStatus === "complete" ? findingsStatus : traversalStatus;

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
