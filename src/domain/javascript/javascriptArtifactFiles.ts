import { z } from "zod";
import { digestSchema } from "../digests.js";
import type { JavaScriptSourceSelection } from "./javascriptSourceSelection.js";
import type { JavaScriptStaticAnalysis } from "./javascriptStaticAnalysisTypes.js";
import type {
  ArtifactInventoryCoverage,
  ArtifactOccurrence,
} from "../artifactGraph.js";
import type { ArtifactInventorySnapshot } from "../artifactInventorySnapshot.js";
import type { JsonValue } from "../jsonValue.js";

/** One physical file occurrence, independent of its graph representations. */
export const javaScriptFileOccurrenceSchema = z.strictObject({
  container_sha256: digestSchema,
  path: z.string().min(1),
  sha256: digestSchema,
});
export type JavaScriptFileOccurrence = z.infer<
  typeof javaScriptFileOccurrenceSchema
>;

/** Whether an inventoried path has a source extension read by the analyzer. */
export const isJavaScriptSourcePath = (path: string): boolean =>
  /\.(?:cjs|cts|mjs|mts|js|jsx|ts|tsx)$/iu.test(path);

/** Relevant file categories projected from the complete artifact inventory. */
export type JavaScriptArtifactFileKind =
  | "package-json"
  | "json"
  | "javascript"
  | "html"
  | "source-map"
  | "native-addon";

/** One content-addressed local artifact file and its text availability. */
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
          | "invalid-utf8"
          | "outside-analysis-scope";
      };
}

/** Producer text exclusions shared by full and incremental source projections. */
export const javaScriptArtifactTextExclusion = (
  file: JavaScriptArtifactFile,
): string | null => {
  if (file.text.included || file.text.reason === "not-applicable") return null;
  if (file.text.reason === "invalid-utf8" && file.kind !== "javascript")
    return null;
  return file.text.reason === "outside-analysis-scope"
    ? "Source was not analyzed because it is outside the caller-selected source_paths."
    : "Source bytes are not valid UTF-8; JavaScript semantics were not analyzed.";
};

/** Source availability shared by semantic consumers of parsed artifact facts. */
export const javaScriptSemanticSourceExclusion = (
  file: JavaScriptArtifactFile,
  parseStatus: JavaScriptStaticAnalysis["parse_status"] | null,
): string | null => {
  if (file.kind !== "javascript") return null;
  return (
    javaScriptArtifactTextExclusion(file) ??
    (parseStatus === "failed"
      ? "JavaScript syntax could not be parsed; JavaScript semantics were not analyzed."
      : null)
  );
};

/**
 * One inventoried regular file not backed by analyzed source bytes. Its inventory
 * occurrence remains available even when content is opaque or unavailable.
 */
export interface JavaScriptUnanalyzedArtifactFile {
  readonly path: string;
  readonly container_sha256: string;
  readonly sha256: string | null;
  readonly bytes: number | null;
  readonly inventory_artifact_id: string | null;
  readonly inventory_occurrence_id?: string;
  readonly kind?: JavaScriptArtifactFileKind;
  readonly artifact_kind?: ArtifactOccurrence["artifact_kind"];
  readonly hash_status?:
    | "verified"
    | "mismatched"
    | "not-hashed"
    | "unavailable";
  readonly limitations?: readonly string[];
}

/** Borrowed inventory lookup; metadata is materialized only for requested paths. */
export interface JavaScriptUnanalyzedArtifactLookup {
  /** Inventory traversal coverage qualifies every negative lookup. */
  readonly coverage: ArtifactInventoryCoverage;
  get(path: string): JavaScriptUnanalyzedArtifactFile | undefined;
  hasDirectory(path: string, containerSha256: string | undefined): boolean;
  /** Indexed observed file paths, including analyzed files, strictly below a directory. */
  filePathsBelow?(path: string): Iterable<string> | undefined;
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
  /** Borrowed inventory lookup for regular files the source projection does not read. */
  readonly unanalyzed_files?: JavaScriptUnanalyzedArtifactLookup;
  /** Relevant inventoried files whose bytes were unavailable. */
  readonly unavailable_relevant_files: readonly JavaScriptUnanalyzedArtifactFile[];
  readonly containers: readonly JavaScriptArtifactContainer[];
  readonly text_bytes_read: number;
  readonly invalid_utf8_files: number;
  readonly source_selection?: JavaScriptSourceSelection;
}

/** Relevant file kinds that make a target a JavaScript application input. */
const APPLICATION_INPUT_KINDS: ReadonlySet<JavaScriptArtifactFileKind> =
  new Set(["javascript", "html", "package-json", "source-map"]);

/**
 * Whether the inventoried target holds anything the JavaScript lane analyzes.
 * `empty` and `absent` require complete traversal; an unavailable relevant
 * file of unknown kind, or incomplete traversal, leaves applicability unknown.
 */
export type JavaScriptApplicationInputPresence =
  | "present"
  | "empty"
  | "absent"
  | "unknown";

/** A non-directory entry beneath the selected root; the root itself is excluded. */
const isContainedEntry = ({
  parent_occurrence_id: parent,
  entry_kind: kind,
}: ArtifactOccurrence): boolean => parent !== null && kind !== "directory";

/** Classify application-input presence from the lane's own inventory facts. */
export const javaScriptApplicationInputPresence = (
  files: JavaScriptArtifactFileSet,
  snapshot: Pick<ArtifactInventorySnapshot, "coverage" | "occurrences">,
): JavaScriptApplicationInputPresence => {
  if (
    files.containers.length > 0 ||
    files.files.some(({ kind }) => APPLICATION_INPUT_KINDS.has(kind)) ||
    files.unavailable_relevant_files.some(
      ({ kind }) => kind !== undefined && APPLICATION_INPUT_KINDS.has(kind),
    )
  )
    return "present";
  if (
    snapshot.coverage.status !== "complete" ||
    files.unavailable_relevant_files.some(({ kind }) => kind === undefined)
  )
    return "unknown";
  return snapshot.occurrences.some(isContainedEntry) ? "absent" : "empty";
};

/**
 * Bounded routing facts for a target without application inputs: entry
 * counts by inventoried format and the JSON and native-addon files the lane
 * classified. No paths are retained.
 */
export const javaScriptAbsentInputDiagnostics = (
  files: JavaScriptArtifactFileSet,
  snapshot: Pick<ArtifactInventorySnapshot, "occurrences">,
): Readonly<Record<string, JsonValue>> => {
  const byFormat = new Map<string, number>();
  let entries = 0;
  for (const occurrence of snapshot.occurrences) {
    if (!isContainedEntry(occurrence)) continue;
    entries += 1;
    const format = occurrence.artifact_format;
    byFormat.set(format, (byFormat.get(format) ?? 0) + 1);
  }
  return {
    inventoried_entries: entries,
    entries_by_format: Object.fromEntries(
      [...byFormat].sort(([left], [right]) => (left < right ? -1 : 1)),
    ),
    json_files: files.files.filter(({ kind }) => kind === "json").length,
    native_addon_files: files.files.filter(
      ({ kind }) => kind === "native-addon",
    ).length,
  };
};

/** Directory-capable and per-file operations for a target the lane does not analyze. */
export const JAVASCRIPT_ABSENT_INPUT_OPERATIONS = [
  "inspect_desktop_application",
  "audit_release_exposure",
  "inspect_artifact",
  "open_binary",
] as const;
