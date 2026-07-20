import type {
  JavaScriptBundlerManifestEntry,
  JavaScriptBundlerManifestObservation,
} from "./JavaScriptArtifactAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "./JavaScriptArtifactFiles.js";

type BundlerManifestKind =
  JavaScriptBundlerManifestObservation["manifest_kind"];

interface BoundedBundlerManifestInput {
  readonly file: JavaScriptArtifactFile;
  readonly bundler: JavaScriptBundlerManifestObservation["bundler"];
  readonly manifestKind: BundlerManifestKind;
  readonly entries: readonly JavaScriptBundlerManifestEntry[];
  readonly maximumEntries: number;
}

/** Parse bounded Vite/Rollup manifests and esbuild metafiles from JSON files. */
export const parseJavaScriptBundlerManifest = (
  file: JavaScriptArtifactFile,
  maximumEntries: number,
): JavaScriptBundlerManifestObservation | null => {
  if (!isBundlerManifestPath(file.path)) return null;
  const manifestKind = manifestKindForPath(file.path);
  if (!file.text.included)
    return unavailableBundlerManifest(file, manifestKind);
  let value: unknown;
  try {
    value = JSON.parse(file.text.value);
  } catch {
    return invalidBundlerManifest(file, manifestKind);
  }
  const parsed =
    manifestKind === "esbuild-metafile"
      ? parseEsbuildMetafile(file, value, maximumEntries)
      : parseRollupLikeManifest(file, value, maximumEntries, manifestKind);
  return parsed ?? invalidBundlerManifest(file, manifestKind);
};

const isBundlerManifestPath = (path: string): boolean => {
  const lower = path.toLowerCase();
  return (
    lower.endsWith("/.vite/manifest.json") ||
    lower === ".vite/manifest.json" ||
    /(?:^|\/)rollup[-_.]?manifest\.json$/u.test(lower) ||
    /(?:^|\/)esbuild[-_.]?(?:meta|metafile)\.json$/u.test(lower)
  );
};

const manifestKindForPath = (path: string): BundlerManifestKind => {
  const lower = path.toLowerCase();
  if (lower.includes("esbuild")) return "esbuild-metafile";
  if (lower.includes("rollup")) return "rollup-manifest";
  return "vite-manifest";
};

const parseRollupLikeManifest = (
  file: JavaScriptArtifactFile,
  value: unknown,
  maximumEntries: number,
  manifestKind: "vite-manifest" | "rollup-manifest",
): JavaScriptBundlerManifestObservation | null => {
  if (!isRecord(value)) return null;
  const all = Object.entries(value).flatMap(([key, raw]) => {
    if (!isRecord(raw) || typeof raw.file !== "string") return [];
    return [
      {
        key: boundedManifestString(key),
        source: boundedNullableString(raw.src),
        file: boundedManifestString(raw.file),
        entry: typeof raw.isEntry === "boolean" ? raw.isEntry : null,
        imports: boundedStringArray(raw.imports),
        dynamic_imports: boundedStringArray(raw.dynamicImports),
        css: boundedStringArray(raw.css),
        assets: boundedStringArray(raw.assets),
      },
    ];
  });
  if (all.length === 0) return null;
  return boundedBundlerManifest({
    file,
    bundler: manifestKind === "vite-manifest" ? "vite" : "rollup",
    manifestKind,
    entries: all,
    maximumEntries,
  });
};

const parseEsbuildMetafile = (
  file: JavaScriptArtifactFile,
  value: unknown,
  maximumEntries: number,
): JavaScriptBundlerManifestObservation | null => {
  if (!isRecord(value) || !isRecord(value.outputs)) return null;
  const all = Object.entries(value.outputs).flatMap(([key, raw]) => {
    if (!isRecord(raw)) return [];
    const imports = esbuildImports(raw.imports);
    return [
      {
        key: boundedManifestString(key),
        source: boundedNullableString(raw.entryPoint),
        file: boundedManifestString(key),
        entry: typeof raw.entryPoint === "string" ? true : null,
        imports: imports.staticImports,
        dynamic_imports: imports.dynamicImports,
        css: boundedStringArray([raw.cssBundle].filter(isString)),
        assets: [],
      },
    ];
  });
  if (all.length === 0) return null;
  return boundedBundlerManifest({
    file,
    bundler: "esbuild",
    manifestKind: "esbuild-metafile",
    entries: all,
    maximumEntries,
  });
};

const boundedBundlerManifest = ({
  file,
  bundler,
  manifestKind,
  entries,
  maximumEntries,
}: BoundedBundlerManifestInput): JavaScriptBundlerManifestObservation => {
  const ordered = [...entries].sort((left, right) =>
    compareCodePoints(left.key, right.key),
  );
  const retained = ordered.slice(0, Math.max(0, maximumEntries));
  const omitted = ordered.length - retained.length;
  return {
    path: file.path,
    sha256: file.sha256,
    status: omitted === 0 ? "included" : "truncated",
    bundler,
    manifest_kind: manifestKind,
    entries: retained,
    omitted_entries: omitted,
    limitation:
      omitted === 0
        ? null
        : "Bundler manifest entries reached the approved finding limit.",
  };
};

const esbuildImports = (
  value: unknown,
): {
  readonly staticImports: readonly string[];
  readonly dynamicImports: readonly string[];
} => {
  if (!Array.isArray(value)) return { staticImports: [], dynamicImports: [] };
  const staticImports: string[] = [];
  const dynamicImports: string[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.path !== "string") continue;
    if (raw.external === true) continue;
    if (raw.kind === "dynamic-import") dynamicImports.push(raw.path);
    else staticImports.push(raw.path);
  }
  return {
    staticImports: sortedBounded(staticImports),
    dynamicImports: sortedBounded(dynamicImports),
  };
};

const unavailableBundlerManifest = (
  file: JavaScriptArtifactFile,
  manifestKind: BundlerManifestKind,
): JavaScriptBundlerManifestObservation => ({
  path: file.path,
  sha256: file.sha256,
  status: "unavailable",
  bundler: bundlerForManifestKind(manifestKind),
  manifest_kind: manifestKind,
  entries: [],
  omitted_entries: null,
  limitation: `Bundler manifest text was unavailable: ${
    file.text.included ? "included" : file.text.reason
  }.`,
});

const invalidBundlerManifest = (
  file: JavaScriptArtifactFile,
  manifestKind: BundlerManifestKind,
): JavaScriptBundlerManifestObservation => ({
  path: file.path,
  sha256: file.sha256,
  status: "invalid",
  bundler: bundlerForManifestKind(manifestKind),
  manifest_kind: manifestKind,
  entries: [],
  omitted_entries: 0,
  limitation: "Bundler manifest is not a recognized bounded schema.",
});

const bundlerForManifestKind = (
  manifestKind: BundlerManifestKind,
): JavaScriptBundlerManifestObservation["bundler"] =>
  manifestKind === "esbuild-metafile"
    ? "esbuild"
    : manifestKind === "rollup-manifest"
      ? "rollup"
      : "vite";

const boundedStringArray = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? sortedBounded(value.filter(isString).map(boundedManifestString))
    : [];

const sortedBounded = (values: readonly string[]): readonly string[] =>
  [...new Set(values.map(boundedManifestString))]
    .sort(compareCodePoints)
    .slice(0, 256);

const boundedNullableString = (value: unknown): string | null =>
  typeof value === "string" ? boundedManifestString(value) : null;

const boundedManifestString = (value: string): string => value.slice(0, 4_096);

const isString = (value: unknown): value is string => typeof value === "string";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
