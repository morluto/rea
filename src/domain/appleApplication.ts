import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import { parseArtifactInventoryEvidence } from "./artifactInventoryEvidence.js";
import { projectBoundedCartesian } from "./boundedCartesianProjection.js";
import { evidenceSchema } from "./evidence.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const boundedPathSchema = z.string().min(1).max(4_096);

const componentSchema = z.strictObject({
  path: boundedPathSchema,
  artifact_id: z.string().regex(/^art_[a-f0-9]{64}$/u),
  sha256: digestSchema,
  format: z.string().min(1).max(100),
});

/** Authenticated artifact inventory pages projected as one Apple application. */
export const appleApplicationProjectionInputSchema = z.strictObject({
  inventory_evidence: z.array(evidenceSchema).min(1).max(100),
  limits: z
    .strictObject({
      max_components: z.number().int().min(1).max(10_000).default(1_000),
    })
    .default({ max_components: 1_000 }),
});

/** Deterministic, execution-free Apple application inventory projection. */
export const appleApplicationProjectionResultSchema = z.strictObject({
  schema_version: z.literal(1),
  projection_id: z.string().regex(/^aap_[a-f0-9]{64}$/u),
  root_sha256: digestSchema,
  root_format: z.literal("ipa"),
  source_evidence_ids: z.array(evidenceIdSchema).min(1).max(100),
  application_roots: z.array(boundedPathSchema),
  components: z.strictObject({
    bundle_metadata: z.array(componentSchema),
    executables: z.array(componentSchema),
    frameworks: z.array(componentSchema),
    native_libraries: z.array(componentSchema),
    javascript: z.array(componentSchema),
    signing: z.array(componentSchema),
  }),
  runtime_families: z.array(
    z.enum([
      "native",
      "swift-objective-c",
      "javascript",
      "react-native",
      "flutter",
      "unity",
    ]),
  ),
  bridge_candidates: z.array(
    z.strictObject({
      source_path: boundedPathSchema,
      native_path: boundedPathSchema,
      basis: z.enum([
        "javascript-and-native-content",
        "react-native-convention",
        "flutter-convention",
        "unity-convention",
      ]),
    }),
  ),
  coverage: z.strictObject({
    status: z.enum(["complete-within-inventory", "partial", "truncated"]),
    inventory_complete: z.boolean(),
    omitted_components: z.number().int().min(0),
    omitted_bridge_candidates: z.number().int().min(0),
  }),
  limitations: z.array(z.string().min(1).max(4_096)).max(100),
});

export type AppleApplicationProjectionInput = z.infer<
  typeof appleApplicationProjectionInputSchema
>;
export type AppleApplicationProjectionResult = z.infer<
  typeof appleApplicationProjectionResultSchema
>;

type Component = z.infer<typeof componentSchema>;

/** Project exact IPA paths and hashes without parsing or executing target code. */
export const projectAppleApplication = (
  input: AppleApplicationProjectionInput,
): AppleApplicationProjectionResult => {
  const parsed = appleApplicationProjectionInputSchema.parse(input);
  const { evidence, inventory } = parseArtifactInventoryEvidence(
    parsed.inventory_evidence,
  );
  if (inventory.manifest.root_format !== "ipa")
    throw new TypeError("Apple application projection requires IPA Evidence");
  const nodes = new Map(
    inventory.nodes.map((node) => [node.artifact_id, node]),
  );
  const all = inventory.occurrences
    .filter(
      (occurrence) =>
        occurrence.artifact_id !== null && occurrence.logical_path !== ".",
    )
    .map((occurrence) => {
      const node = nodes.get(occurrence.artifact_id ?? "");
      if (node === undefined)
        throw new TypeError(
          "Apple application occurrence has no artifact node",
        );
      return {
        path: occurrence.logical_path,
        artifact_id: node.artifact_id,
        sha256: node.sha256,
        format: node.format,
      } satisfies Component;
    });
  const roots = [
    ...new Set(
      inventory.occurrences.flatMap(({ logical_path: path }) => {
        const match = /^(Payload\/[^/]+\.app)(?:\/|$)/u.exec(path);
        return match?.[1] === undefined ? [] : [match[1]];
      }),
    ),
  ].sort(compare);
  const classified = classifyComponents(all, roots);
  const retained = retainComponents(classified, parsed.limits.max_components);
  const omitted = componentCount(classified) - componentCount(retained);
  const runtimeFamilies = identifyRuntimeFamilies(all);
  const bridgeProjection = identifyBridgeCandidates(
    retained.javascript,
    [...retained.frameworks, ...retained.native_libraries],
    parsed.limits.max_components,
  );
  const limitations = projectionLimitations(
    inventory.complete,
    omitted,
    bridgeProjection.omitted,
    roots,
  );
  const withoutId = {
    schema_version: 1 as const,
    root_sha256: inventory.manifest.root_sha256,
    root_format: "ipa" as const,
    source_evidence_ids: evidence
      .map(({ evidence_id: id }) => id)
      .sort(compare),
    application_roots: roots,
    components: retained,
    runtime_families: runtimeFamilies,
    bridge_candidates: bridgeProjection.candidates,
    coverage: {
      status:
        omitted > 0 || bridgeProjection.omitted > 0
          ? ("truncated" as const)
          : inventory.complete
            ? ("complete-within-inventory" as const)
            : ("partial" as const),
      inventory_complete: inventory.complete,
      omitted_components: omitted,
      omitted_bridge_candidates: bridgeProjection.omitted,
    },
    limitations,
  };
  return appleApplicationProjectionResultSchema.parse({
    ...withoutId,
    projection_id: `aap_${digest(withoutId)}`,
  });
};

const classifyComponents = (
  all: readonly Component[],
  roots: readonly string[],
) => {
  const withinApp = (path: string): boolean =>
    roots.some((root) => path.startsWith(`${root}/`));
  return {
    bundle_metadata: all.filter(({ path }) =>
      /(?:^|\/)Info\.plist$/u.test(path),
    ),
    executables: all.filter(
      ({ path, format }) =>
        withinApp(path) && ["mach-o", "mach-o-universal"].includes(format),
    ),
    frameworks: all.filter(({ path }) => /\.framework\//u.test(path)),
    native_libraries: all.filter(({ path }) => /\.(?:dylib|so)$/iu.test(path)),
    javascript: all.filter(({ format }) => format === "javascript-bundle"),
    signing: all.filter(({ path }) =>
      /(?:^|\/)(?:embedded\.mobileprovision|_CodeSignature\/CodeResources)$/u.test(
        path,
      ),
    ),
  };
};

const retainComponents = <Groups extends Record<string, readonly Component[]>>(
  groups: Groups,
  maximum: number,
): { [Key in keyof Groups]: Component[] } => {
  let remaining = maximum;
  return Object.fromEntries(
    Object.entries(groups).map(([key, values]) => {
      const retained = [...values]
        .sort((left, right) => compare(left.path, right.path))
        .slice(0, remaining);
      remaining -= retained.length;
      return [key, retained];
    }),
  ) as { [Key in keyof Groups]: Component[] };
};

const componentCount = (groups: Record<string, readonly Component[]>): number =>
  Object.values(groups).reduce((total, values) => total + values.length, 0);

const identifyRuntimeFamilies = (all: readonly Component[]) => {
  const paths = all.map(({ path }) => path.toLowerCase());
  const families = new Set<
    z.infer<
      typeof appleApplicationProjectionResultSchema
    >["runtime_families"][number]
  >();
  if (all.some(({ format }) => ["mach-o", "mach-o-universal"].includes(format)))
    families.add("native");
  if (paths.some((path) => /\.(?:dylib|framework\/[^/]+)$/u.test(path)))
    families.add("swift-objective-c");
  if (all.some(({ format }) => format === "javascript-bundle"))
    families.add("javascript");
  if (
    paths.some(
      (path) =>
        path.includes("reactnative") ||
        path.includes("react.framework") ||
        path.includes("hermes"),
    )
  )
    families.add("react-native");
  if (
    paths.some(
      (path) =>
        path.includes("flutter.framework") || path.includes("app.framework"),
    )
  )
    families.add("flutter");
  if (paths.some((path) => path.includes("unityframework.framework")))
    families.add("unity");
  return [...families].sort(compare);
};

const identifyBridgeCandidates = (
  scripts: readonly Component[],
  native: readonly Component[],
  maximum: number,
) => {
  const projection = projectBoundedCartesian(
    scripts,
    native,
    maximum,
    (script, item) => ({
      source_path: script.path,
      native_path: item.path,
      basis: bridgeBasis(item.path),
    }),
  );
  return {
    candidates: projection.values,
    omitted: projection.omitted,
  };
};

const bridgeBasis = (
  path: string,
):
  | "javascript-and-native-content"
  | "react-native-convention"
  | "flutter-convention"
  | "unity-convention" => {
  const lower = path.toLowerCase();
  if (lower.includes("react")) return "react-native-convention";
  if (lower.includes("flutter") || lower.includes("app.framework"))
    return "flutter-convention";
  if (lower.includes("unity")) return "unity-convention";
  return "javascript-and-native-content";
};

const projectionLimitations = (
  complete: boolean,
  omitted: number,
  omittedBridges: number,
  roots: readonly string[],
): string[] => [
  ...(!complete
    ? ["Source inventory pages are incomplete; absence is unknown."]
    : []),
  ...(omitted > 0
    ? [
        `${String(omitted)} component observations were omitted by the projection limit.`,
      ]
    : []),
  ...(omittedBridges > 0
    ? [
        `${String(omittedBridges)} bridge hypotheses were omitted by the projection limit.`,
      ]
    : []),
  ...(roots.length === 0
    ? [
        "No Payload/*.app directory was present in the supplied inventory pages.",
      ]
    : []),
  "Bundle identifiers and signing claims require dedicated plist and CMS parsing; this projection reports only exact paths and hashes.",
  "Bridge candidates are path-based hypotheses, not observed runtime calls.",
];

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const digest = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Apple application projection is not canonical JSON");
  return createHash("sha256").update(encoded).digest("hex");
};
