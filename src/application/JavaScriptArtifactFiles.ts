import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Readable } from "node:stream";

import { AsarArtifactReader } from "../artifacts/AsarArtifactReader.js";
import {
  ArtifactPathRegistry,
  normalizeArtifactPath,
} from "../artifacts/ArtifactPaths.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReader,
} from "../artifacts/ArtifactReader.js";
import { streamChunkToBuffer } from "../artifacts/StreamBytes.js";
import type { ArtifactInventorySnapshot } from "./ArtifactInventory.js";
import type { JavaScriptArtifactReconstructionInput } from "./JavaScriptArtifactReconstructionInput.js";

/** Relevant file categories projected from the complete artifact inventory. */
export type JavaScriptArtifactFileKind =
  | "package-json"
  | "json"
  | "javascript"
  | "html"
  | "source-map"
  | "native-addon";

/** One content-addressed local artifact file and its bounded text availability. */
export interface JavaScriptArtifactFile {
  readonly path: string;
  readonly container_sha256: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly inventory_artifact_id: string;
  readonly kind: JavaScriptArtifactFileKind;
  readonly unpacked: boolean;
  readonly text:
    | { readonly included: true; readonly value: string }
    | {
        readonly included: false;
        readonly reason:
          | "not-applicable"
          | "not-approved"
          | "file-limit"
          | "byte-limit"
          | "invalid-utf8";
      };
}

/** One filesystem-backed ASAR nested beneath a directory input. */
export interface JavaScriptArtifactContainer {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly inventory_artifact_id: string;
}

/** Deterministic relevant-file projection plus explicit omissions. */
export interface JavaScriptArtifactFileSet {
  readonly files: readonly JavaScriptArtifactFile[];
  readonly containers: readonly JavaScriptArtifactContainer[];
  readonly text_files_selected: number;
  readonly text_bytes_read: number;
  readonly omitted_text_files: number;
  readonly limit_omitted_text_files: number;
  readonly policy_filtered_text_files: number;
  readonly invalid_utf8_files: number;
}

interface ExpectedFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly inventoryArtifactId: string;
  readonly kind: JavaScriptArtifactFileKind;
}

interface Selection {
  readonly selected: boolean;
  readonly reason: "file-limit" | "byte-limit" | "not-approved" | null;
}

interface ReadContext {
  readonly input: JavaScriptArtifactReconstructionInput;
  readonly expected: ReadonlyMap<string, ExpectedFile>;
  readonly expectedContainers: ReadonlyMap<string, JavaScriptArtifactContainer>;
  readonly selections: ReadonlyMap<string, Selection>;
  readonly registry: ArtifactPathRegistry;
  readonly files: JavaScriptArtifactFile[];
  readonly containers: JavaScriptArtifactContainer[];
  readonly signal: AbortSignal | undefined;
  textBytes: number;
  invalidUtf8: number;
}

interface ReadTextInput {
  readonly reader: ArtifactReader;
  readonly entry: ArtifactEntry;
  readonly expected: ExpectedFile;
  readonly selection: Selection | undefined;
}

/** Read only selected textual entries through an already-inventoried reader. */
export const readJavaScriptArtifactFiles = async (
  reader: ArtifactReader,
  snapshot: ArtifactInventorySnapshot,
  input: JavaScriptArtifactReconstructionInput,
  signal?: AbortSignal,
): Promise<JavaScriptArtifactFileSet> => {
  const inventory = expectedInventory(snapshot);
  const expected = inventory.files;
  const selections = selectTextFiles(expected, input);
  const context: ReadContext = {
    input,
    expected,
    expectedContainers: inventory.containers,
    selections,
    registry: new ArtifactPathRegistry(),
    files: [],
    containers: [],
    signal,
    textBytes: 0,
    invalidUtf8: 0,
  };
  await visitReader(reader, "", snapshot.manifest.root_sha256, context);
  const files = context.files.sort((left, right) =>
    compareCodePoints(left.path, right.path),
  );
  assertExpectedFilesWereVisited(expected, files);
  const selected = [...selections.values()].filter(
    ({ selected: isSelected }) => isSelected,
  ).length;
  return {
    files,
    containers: context.containers.sort((left, right) =>
      compareCodePoints(left.path, right.path),
    ),
    text_files_selected: selected,
    text_bytes_read: context.textBytes,
    omitted_text_files: [...selections.values()].filter(
      ({ selected: isSelected }) => !isSelected,
    ).length,
    limit_omitted_text_files: [...selections.values()].filter(
      ({ reason }) => reason === "file-limit" || reason === "byte-limit",
    ).length,
    policy_filtered_text_files: [...selections.values()].filter(
      ({ reason }) => reason === "not-approved",
    ).length,
    invalid_utf8_files: context.invalidUtf8,
  };
};

const visitReader = async (
  reader: ArtifactReader,
  prefix: string,
  containerSha256: string,
  context: ReadContext,
): Promise<void> => {
  for await (const entry of reader.entries(context.signal)) {
    abortIfNeeded(context.signal);
    const path = normalizeArtifactPath(
      prefix === "" ? entry.path : `${prefix}/${entry.path}`,
      {
        maxDepth: context.input.limits.max_depth,
        maxPathBytes: context.input.limits.max_path_bytes,
      },
    );
    const nestedAsar = isFilesystemAsar(entry, path);
    context.registry.add(path, nestedAsar ? "directory" : entry.kind);
    if (nestedAsar) {
      await visitNestedAsar(entry, path, context);
      continue;
    }
    const expected = context.expected.get(path);
    if (expected === undefined) continue;
    const selection = context.selections.get(path);
    const text = await readTextIfSelected(context, {
      reader,
      entry,
      expected,
      selection,
    });
    context.files.push({
      path,
      container_sha256: containerSha256,
      sha256: expected.sha256,
      bytes: expected.bytes,
      inventory_artifact_id: expected.inventoryArtifactId,
      kind: expected.kind,
      unpacked: entry.unpacked,
      text,
    });
  }
};

const visitNestedAsar = async (
  entry: ArtifactEntry,
  path: string,
  context: ReadContext,
): Promise<void> => {
  const inventory = expectedContainer(path, context);
  context.containers.push(inventory);
  const nested = new AsarArtifactReader(entry.adapterKey);
  try {
    await visitReader(nested, path, inventory.sha256, context);
  } finally {
    await nested.close();
  }
};

const expectedContainer = (
  path: string,
  context: ReadContext,
): JavaScriptArtifactContainer => {
  const container = context.expectedContainers.get(path);
  if (container === undefined)
    throw new ArtifactReaderFailure(
      "integrity",
      `Nested ASAR disappeared from inventory: ${path}`,
    );
  return container;
};

const readTextIfSelected = async (
  context: ReadContext,
  input: ReadTextInput,
): Promise<JavaScriptArtifactFile["text"]> => {
  if (input.expected.kind === "native-addon")
    return { included: false, reason: "not-applicable" };
  if (input.selection?.selected !== true)
    return {
      included: false,
      reason: input.selection?.reason ?? "file-limit",
    };
  const bytes = await readBounded(
    await input.reader.open(input.entry, context.signal),
    context.input.limits.max_text_file_bytes,
    context.signal,
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== input.expected.sha256 || bytes.length !== input.expected.bytes)
    throw new ArtifactReaderFailure(
      "integrity",
      `Artifact entry changed after inventory: ${input.expected.path}`,
    );
  context.textBytes += bytes.length;
  try {
    return {
      included: true,
      value: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    context.invalidUtf8 += 1;
    return { included: false, reason: "invalid-utf8" };
  }
};

const expectedInventory = (
  snapshot: ArtifactInventorySnapshot,
): {
  readonly files: ReadonlyMap<string, ExpectedFile>;
  readonly containers: ReadonlyMap<string, JavaScriptArtifactContainer>;
} => {
  const nodes = new Map(snapshot.nodes.map((node) => [node.artifact_id, node]));
  const files = new Map<string, ExpectedFile>();
  const containers = new Map<string, JavaScriptArtifactContainer>();
  for (const occurrence of snapshot.occurrences) {
    if (occurrence.artifact_id === null || occurrence.logical_path === ".")
      continue;
    const node = nodes.get(occurrence.artifact_id);
    if (node === undefined)
      throw new ArtifactReaderFailure(
        "integrity",
        `Artifact inventory node is missing: ${occurrence.logical_path}`,
      );
    if (occurrence.logical_path.toLowerCase().endsWith(".asar"))
      containers.set(occurrence.logical_path, {
        path: occurrence.logical_path,
        sha256: node.sha256,
        bytes: node.size,
        inventory_artifact_id: node.artifact_id,
      });
    const kind = relevantKind(occurrence.logical_path);
    if (kind === undefined) continue;
    files.set(occurrence.logical_path, {
      path: occurrence.logical_path,
      sha256: node.sha256,
      bytes: node.size,
      inventoryArtifactId: node.artifact_id,
      kind,
    });
  }
  return { files, containers };
};

const selectTextFiles = (
  files: ReadonlyMap<string, ExpectedFile>,
  input: JavaScriptArtifactReconstructionInput,
): ReadonlyMap<string, Selection> => {
  const selected = new Map<string, Selection>();
  let fileCount = 0;
  let bytes = 0;
  const ordered = [...files.values()].sort((left, right) => {
    const priority = filePriority(left.kind) - filePriority(right.kind);
    return priority === 0 ? compareCodePoints(left.path, right.path) : priority;
  });
  for (const file of ordered) {
    if (file.kind === "native-addon") continue;
    if (file.kind === "source-map" && !input.source_map_read_approved) {
      selected.set(file.path, { selected: false, reason: "not-approved" });
      continue;
    }
    if (
      fileCount >= input.limits.max_text_files ||
      file.bytes > input.limits.max_text_file_bytes
    ) {
      selected.set(file.path, { selected: false, reason: "file-limit" });
      continue;
    }
    if (bytes + file.bytes > input.limits.max_total_text_bytes) {
      selected.set(file.path, { selected: false, reason: "byte-limit" });
      continue;
    }
    selected.set(file.path, { selected: true, reason: null });
    fileCount += 1;
    bytes += file.bytes;
  }
  return selected;
};

const readBounded = async (
  stream: Readable,
  maximum: number,
  signal?: AbortSignal,
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of stream) {
    abortIfNeeded(signal);
    const chunk = streamChunkToBuffer(raw);
    bytes += chunk.length;
    if (bytes > maximum) {
      stream.destroy();
      throw new ArtifactReaderFailure(
        "limit",
        "Selected JavaScript artifact text exceeded its byte limit",
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
};

const assertExpectedFilesWereVisited = (
  expected: ReadonlyMap<string, ExpectedFile>,
  actual: readonly JavaScriptArtifactFile[],
): void => {
  const observed = new Set(actual.map(({ path }) => path));
  for (const path of expected.keys())
    if (!observed.has(path))
      throw new ArtifactReaderFailure(
        "integrity",
        `Relevant artifact entry disappeared after inventory: ${path}`,
      );
};

const relevantKind = (path: string): JavaScriptArtifactFileKind | undefined => {
  const lower = path.toLowerCase();
  if (lower === "package.json" || lower.endsWith("/package.json"))
    return "package-json";
  if (lower.endsWith(".json")) return "json";
  if (/\.(?:cjs|mjs|js|jsx|ts|tsx)$/u.test(lower)) return "javascript";
  if (/\.html?$/u.test(lower)) return "html";
  if (lower.endsWith(".map")) return "source-map";
  if (lower.endsWith(".node")) return "native-addon";
  return undefined;
};

const filePriority = (kind: JavaScriptArtifactFileKind): number => {
  switch (kind) {
    case "package-json":
      return 0;
    case "html":
      return 1;
    case "javascript":
      return 2;
    case "json":
      return 3;
    case "source-map":
      return 4;
    case "native-addon":
      return 5;
  }
};

const isFilesystemAsar = (entry: ArtifactEntry, path: string): boolean =>
  entry.kind === "file" &&
  path.toLowerCase().endsWith(".asar") &&
  isAbsolute(entry.adapterKey);

const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure(
      "cancelled",
      "JavaScript artifact reconstruction cancelled",
    );
};

const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
