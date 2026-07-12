import { createHash } from "node:crypto";
import { posix } from "node:path";

import canonicalize from "canonicalize";
import { z } from "zod";

const MAX_PATH = 4_096;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const boundedTextSchema = z.string().min(1).max(1_024);
const relativePathSchema = z
  .string()
  .min(1)
  .max(MAX_PATH)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      path
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Expected a normalized relative POSIX path without traversal",
  );

const classificationSchema = z.enum([
  "source",
  "test",
  "config",
  "manifest",
  "generated",
  "vendor",
  "documentation",
  "unknown",
]);

const entryBaseShape = {
  path: relativePathSchema,
  classifications: z.array(classificationSchema).min(1).max(8),
  limitations: z.array(boundedTextSchema).max(100),
};

const sourceFileSchema = z
  .strictObject({
    ...entryBaseShape,
    kind: z.literal("file"),
    sha256: digestSchema.nullable(),
    size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    language: z.string().min(1).max(100).nullable(),
    content_state: z.enum([
      "hashed",
      "redacted-secret",
      "excluded",
      "unreadable",
      "too-large",
      "unknown",
    ]),
  })
  .superRefine((file, context) => {
    checkSortedUnique(file.classifications, "classifications", context);
    if ((file.content_state === "hashed") !== (file.sha256 !== null))
      context.addIssue({
        code: "custom",
        message: "Only hashed files have a content digest",
        path: ["sha256"],
      });
    if (file.content_state === "hashed" && file.size === null)
      context.addIssue({
        code: "custom",
        message: "Hashed files require a byte size",
        path: ["size"],
      });
  });

const sourceDirectorySchema = z.strictObject({
  ...entryBaseShape,
  kind: z.literal("directory"),
  tree_state: z.enum([
    "enumerated",
    "partial",
    "excluded",
    "unreadable",
    "unknown",
  ]),
});

const symlinkTargetSchema = z
  .string()
  .min(1)
  .max(MAX_PATH)
  .refine(
    (target) =>
      target === "<outside-root>" ||
      (!target.startsWith("/") &&
        !target.includes("\\") &&
        posix.normalize(target) === target),
    "Expected a normalized POSIX symlink target",
  );

const sourceSymlinkSchema = z.strictObject({
  ...entryBaseShape,
  kind: z.literal("symlink"),
  target: symlinkTargetSchema,
  target_state: z.enum([
    "internal",
    "external",
    "missing",
    "unreadable",
    "unknown",
  ]),
});

const sourceEntrySchema = z.discriminatedUnion("kind", [
  sourceFileSchema,
  sourceDirectorySchema,
  sourceSymlinkSchema,
]);

const sourceRelationshipSchema = z.strictObject({
  from_path: relativePathSchema,
  to: z.string().min(1).max(MAX_PATH),
  kind: z.enum(["imports", "requires", "references", "declares-module"]),
  resolution: z.enum(["internal", "external", "unresolved", "unknown"]),
  parse_state: z.enum(["parsed", "partial", "unknown"]),
});

const parseFailureSchema = z.strictObject({
  path: relativePathSchema,
  parser: z.string().min(1).max(100),
  reason: boundedTextSchema,
});

const exclusionSchema = z.strictObject({
  path: relativePathSchema,
  reason: z.enum([
    "configured-secret",
    "symlink-escape",
    "size-limit",
    "inventory-limit",
    "unreadable",
    "caller-excluded",
  ]),
});

const vcsSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("git"),
      head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
      dirty: z.boolean(),
    }),
    z.strictObject({
      kind: z.literal("none"),
      head: z.null(),
      dirty: z.null(),
    }),
    z.strictObject({
      kind: z.literal("unknown"),
      head: z.null(),
      dirty: z.null(),
    }),
  ])
  .nullable();

const graphShape = {
  schema: z.literal("HistoricalSourceGraph/v1"),
  authority: z.literal("historical-reference"),
  root_alias: z.literal("$REFERENCE_ROOT"),
  root_sha256: digestSchema,
  inventory_state: z.enum(["complete", "partial", "unknown"]),
  entries: z.array(sourceEntrySchema).max(100_000),
  relationships: z.array(sourceRelationshipSchema).max(200_000),
  parse_failures: z.array(parseFailureSchema).max(10_000),
  exclusions: z.array(exclusionSchema).max(100_000),
  languages: z.array(z.string().min(1).max(100)).max(1_000),
  manifests: z.array(relativePathSchema).max(10_000),
  vcs: vcsSchema,
  provenance: z.strictObject({
    importer: z.string().min(1).max(100),
    importer_version: z.string().min(1).max(100).nullable(),
    caller: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\w .:@/+-]+$/u),
  }),
  limitations: z.array(boundedTextSchema).max(1_000),
};

const historicalSourceGraphStructureSchema = z
  .strictObject(graphShape)
  .superRefine(checkGraphInvariants);

export const historicalSourceGraphSchema =
  historicalSourceGraphStructureSchema.superRefine((graph, context) => {
    if (
      computeRootSha256(graph.entries, graph.exclusions) !== graph.root_sha256
    )
      context.addIssue({
        code: "custom",
        message: "Historical source root commitment does not match entries",
        path: ["root_sha256"],
      });
  });

const historicalSourceGraphInputSchema = z.strictObject({
  ...graphShape,
  root_sha256: z.never().optional(),
});

const historicalSourceManifestBaseSchema = z.strictObject({
  schema: z.literal("HistoricalSourceManifest/v1"),
  authority: z.literal("historical-reference"),
  manifest_id: z.string().regex(/^hsm_[a-f0-9]{64}$/u),
  graph_sha256: digestSchema,
  root_sha256: digestSchema,
  inventory_state: z.enum(["complete", "partial", "unknown"]),
  entry_count: z.number().int().min(0).max(100_000),
  relationship_count: z.number().int().min(0).max(200_000),
});

export type HistoricalSourceGraph = z.infer<typeof historicalSourceGraphSchema>;
export type HistoricalSourceGraphInput = z.infer<
  typeof historicalSourceGraphInputSchema
>;
export type HistoricalSourceManifest = z.infer<
  typeof historicalSourceManifestBaseSchema
>;

const canonicalJson = (value: unknown): string => {
  const serialized = canonicalize(value);
  if (serialized === undefined)
    throw new TypeError("RFC 8785 canonicalization rejected a graph value");
  return serialized;
};

const digestCanonical = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const relationshipKey = (
  relationship: z.infer<typeof sourceRelationshipSchema>,
): string =>
  `${relationship.from_path}\u0000${relationship.to}\u0000${relationship.kind}\u0000${relationship.resolution}\u0000${relationship.parse_state}`;

const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const checkSortedUnique = (
  values: readonly string[],
  field: string,
  context: z.RefinementCtx,
): void => {
  for (let index = 1; index < values.length; index += 1)
    if (compareCodePoints(values[index - 1] ?? "", values[index] ?? "") >= 0) {
      context.addIssue({
        code: "custom",
        message: `${field} must be sorted and unique by Unicode code point`,
        path: [field, index],
      });
      return;
    }
};

const expectedLanguages = (
  entries: readonly z.infer<typeof sourceEntrySchema>[],
): string[] =>
  [
    ...new Set(
      entries.flatMap((entry) =>
        entry.kind === "file" && entry.language !== null
          ? [entry.language]
          : [],
      ),
    ),
  ].sort(compareCodePoints);

const expectedManifests = (
  entries: readonly z.infer<typeof sourceEntrySchema>[],
): string[] =>
  entries
    .flatMap((entry) =>
      entry.kind === "file" && entry.classifications.includes("manifest")
        ? [entry.path]
        : [],
    )
    .sort(compareCodePoints);

type GraphStructure = z.infer<typeof historicalSourceGraphStructureSchema>;

const checkRelationships = (
  graph: GraphStructure,
  paths: ReadonlySet<string>,
  context: z.RefinementCtx,
): void => {
  const files = new Set(
    graph.entries.flatMap((entry) =>
      entry.kind === "file" ? [entry.path] : [],
    ),
  );
  for (const [index, relationship] of graph.relationships.entries()) {
    if (!files.has(relationship.from_path))
      context.addIssue({
        code: "custom",
        message: "Relationship source must name an inventoried file",
        path: ["relationships", index, "from_path"],
      });
    if (relationship.resolution !== "internal") continue;
    const parsed = relativePathSchema.safeParse(relationship.to);
    if (!parsed.success || !paths.has(parsed.data))
      context.addIssue({
        code: "custom",
        message:
          "Internal relationship target must be normalized and inventoried",
        path: ["relationships", index, "to"],
      });
  }
};

const checkSymlinks = (
  graph: GraphStructure,
  paths: ReadonlySet<string>,
  context: z.RefinementCtx,
): void => {
  for (const [index, entry] of graph.entries.entries()) {
    if (entry.kind !== "symlink") continue;
    if (
      (entry.target_state === "external") !==
      (entry.target === "<outside-root>")
    )
      context.addIssue({
        code: "custom",
        message:
          "External symlink targets must use the sanitized <outside-root> sentinel",
        path: ["entries", index, "target"],
      });
    if (entry.target_state !== "internal") continue;
    const resolved = posix.normalize(
      posix.join(posix.dirname(entry.path), entry.target),
    );
    if (resolved.startsWith("../") || resolved === ".." || !paths.has(resolved))
      context.addIssue({
        code: "custom",
        message: "Internal symlink target must resolve to an inventoried entry",
        path: ["entries", index, "target"],
      });
  }
};

const checkCompleteInventory = (
  graph: GraphStructure,
  context: z.RefinementCtx,
): void => {
  if (graph.inventory_state !== "complete") return;
  const partialEntry = graph.entries.some(
    (entry) =>
      entry.limitations.length > 0 ||
      (entry.kind === "file" && entry.content_state !== "hashed") ||
      (entry.kind === "directory" && entry.tree_state !== "enumerated") ||
      (entry.kind === "symlink" && entry.target_state !== "internal"),
  );
  const partialRelationship = graph.relationships.some(
    ({ parse_state, resolution }) =>
      parse_state !== "parsed" ||
      ["unresolved", "unknown"].includes(resolution),
  );
  if (
    !partialEntry &&
    !partialRelationship &&
    graph.parse_failures.length === 0 &&
    graph.exclusions.length === 0 &&
    graph.limitations.length === 0
  )
    return;
  context.addIssue({
    code: "custom",
    message:
      "Complete inventory cannot contain partial states, exclusions, failures, or limitations",
    path: ["inventory_state"],
  });
};

function checkGraphInvariants(
  graph: GraphStructure,
  context: z.RefinementCtx,
): void {
  checkSortedUnique(
    graph.entries.map(({ path }) => path),
    "entries",
    context,
  );
  for (const [index, entry] of graph.entries.entries())
    checkSortedUnique(
      entry.classifications,
      `entries.${index}.classifications`,
      context,
    );
  checkSortedUnique(graph.languages, "languages", context);
  checkSortedUnique(graph.manifests, "manifests", context);
  checkSortedUnique(
    graph.relationships.map(relationshipKey),
    "relationships",
    context,
  );
  checkSortedUnique(
    graph.parse_failures.map(({ path, parser }) => `${path}\u0000${parser}`),
    "parse_failures",
    context,
  );
  checkSortedUnique(
    graph.exclusions.map(({ path, reason }) => `${path}\u0000${reason}`),
    "exclusions",
    context,
  );

  if (
    canonicalJson(graph.languages) !==
    canonicalJson(expectedLanguages(graph.entries))
  )
    context.addIssue({
      code: "custom",
      message: "languages must be derived from file entries",
      path: ["languages"],
    });
  if (
    canonicalJson(graph.manifests) !==
    canonicalJson(expectedManifests(graph.entries))
  )
    context.addIssue({
      code: "custom",
      message: "manifests must be derived from classified file entries",
      path: ["manifests"],
    });

  const paths = new Set(graph.entries.map(({ path }) => path));
  checkRelationships(graph, paths, context);
  checkSymlinks(graph, paths, context);
  checkCompleteInventory(graph, context);
}

const rootCommitment = (
  entries: readonly z.infer<typeof sourceEntrySchema>[],
  exclusions: readonly z.infer<typeof exclusionSchema>[],
): unknown => ({
  entries: entries.map((entry) => {
    switch (entry.kind) {
      case "file":
        return {
          kind: entry.kind,
          path: entry.path,
          sha256: entry.sha256,
          size: entry.size,
          content_state: entry.content_state,
        };
      case "directory":
        return {
          kind: entry.kind,
          path: entry.path,
          tree_state: entry.tree_state,
        };
      case "symlink":
        return {
          kind: entry.kind,
          path: entry.path,
          target: entry.target,
          target_state: entry.target_state,
        };
    }
  }),
  exclusions,
});

const computeRootSha256 = (
  entries: readonly z.infer<typeof sourceEntrySchema>[],
  exclusions: readonly z.infer<typeof exclusionSchema>[],
): string => digestCanonical(rootCommitment(entries, exclusions));

/** Build and internally commit a normalized historical source graph. */
export const createHistoricalSourceGraph = (
  input: unknown,
): HistoricalSourceGraph => {
  const parsed = historicalSourceGraphInputSchema.parse(input);
  return historicalSourceGraphSchema.parse({
    ...parsed,
    root_sha256: computeRootSha256(parsed.entries, parsed.exclusions),
  });
};

/** Parse a graph and reject stale or caller-invented root commitments. */
export const parseHistoricalSourceGraph = (
  input: unknown,
): HistoricalSourceGraph => historicalSourceGraphSchema.parse(input);

/** Compute a deterministic graph commitment containing no absolute root path. */
export const computeHistoricalSourceGraphSha256 = (input: unknown): string =>
  digestCanonical(parseHistoricalSourceGraph(input));

/** Build a deterministic, relocation-independent manifest for a source graph. */
export const createHistoricalSourceManifest = (
  input: unknown,
): HistoricalSourceManifest => {
  const graph = parseHistoricalSourceGraph(input);
  const semantic = {
    schema: "HistoricalSourceManifest/v1" as const,
    authority: "historical-reference" as const,
    graph_sha256: computeHistoricalSourceGraphSha256(graph),
    root_sha256: graph.root_sha256,
    inventory_state: graph.inventory_state,
    entry_count: graph.entries.length,
    relationship_count: graph.relationships.length,
  };
  return historicalSourceManifestBaseSchema.parse({
    ...semantic,
    manifest_id: `hsm_${digestCanonical(semantic)}`,
  });
};

/** Parse and verify a historical source manifest's semantic identifier. */
export const parseHistoricalSourceManifest = (
  input: unknown,
): HistoricalSourceManifest => {
  const manifest = historicalSourceManifestBaseSchema.parse(input);
  const { manifest_id: manifestId, ...semantic } = manifest;
  if (`hsm_${digestCanonical(semantic)}` !== manifestId)
    throw new TypeError("Historical source manifest identifier does not match");
  return manifest;
};
