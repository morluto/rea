import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import {
  appleBundleSchema,
  appleComponentSchema,
  applicationRoots,
  detectBundles,
  isMachOFormat,
  isSidecar,
  isWithin,
  platformsOf,
  type AppleInventoryEntry,
} from "./appleBundleAnatomy.js";
import { parseArtifactInventoryEvidence } from "../artifactInventoryEvidence.js";
import { evidenceSchema } from "../evidence.js";
import { digestSchema } from "../digests.js";
import { prefixedDigestSchema } from "../digests.js";
import {
  bridgeCandidateCoverageSchema,
  projectCartesianCandidates,
} from "../bridgeCandidateProjection.js";

const evidenceIdSchema = prefixedDigestSchema("ev");
const pathSchema = z.string().min(1);

const APPLE_ROOT_FORMATS = ["ipa", "directory", "zip", "dmg"] as const;

/** Authenticated artifact inventory pages projected as one Apple application. */
export const appleApplicationProjectionInputSchema = z.strictObject({
  inventory_evidence: z.array(evidenceSchema).min(1),
});

/** Deterministic, execution-free Apple application inventory projection. */
export const appleApplicationProjectionResultSchema = z.strictObject({
  projection_id: prefixedDigestSchema("aap"),
  root_sha256: digestSchema,
  root_format: z.enum(APPLE_ROOT_FORMATS),
  platforms: z.array(z.enum(["ios", "macos"])),
  source_evidence_ids: z.array(evidenceIdSchema).min(1),
  application_roots: z.array(pathSchema),
  bundles: z.array(appleBundleSchema),
  components: z.strictObject({
    bundle_metadata: z.array(appleComponentSchema),
    executables: z.array(appleComponentSchema),
    frameworks: z.array(appleComponentSchema),
    native_libraries: z.array(appleComponentSchema),
    javascript: z.array(appleComponentSchema),
    signing: z.array(appleComponentSchema),
    privileged_helpers: z.array(appleComponentSchema),
    launchd_plists: z.array(
      appleComponentSchema.extend({ domain: z.enum(["agent", "daemon"]) }),
    ),
    helpers: z.array(appleComponentSchema),
  }),
  symlinks: z.array(pathSchema),
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
      source_path: pathSchema,
      native_path: pathSchema,
      basis: z.enum([
        "javascript-and-native-content",
        "react-native-convention",
        "flutter-convention",
        "unity-convention",
      ]),
    }),
  ),
  bridge_candidate_coverage: bridgeCandidateCoverageSchema,
  coverage: z.strictObject({
    status: z.enum(["complete-within-inventory", "partial"]),
    inventory_complete: z.boolean(),
  }),
  limitations: z.array(z.string().min(1)),
});

export type AppleApplicationProjectionInput = z.infer<
  typeof appleApplicationProjectionInputSchema
>;
export type AppleApplicationProjectionResult = z.infer<
  typeof appleApplicationProjectionResultSchema
>;

type Component = z.infer<typeof appleComponentSchema>;
type RootFormat = (typeof APPLE_ROOT_FORMATS)[number];

/** Project exact Apple application paths and hashes without parsing or executing target code. */
export const projectAppleApplication = (
  input: AppleApplicationProjectionInput,
): AppleApplicationProjectionResult => {
  const parsed = appleApplicationProjectionInputSchema.parse(input);
  const { evidence, inventory } = parseArtifactInventoryEvidence(
    parsed.inventory_evidence,
  );
  const rootFormat = appleRootFormat(inventory.manifest.root_format);
  const nodes = new Map(
    inventory.nodes.map((node) => [node.artifact_id, node]),
  );
  const entries: AppleInventoryEntry[] = inventory.occurrences
    .filter(({ logical_path: path }) => path !== ".")
    .map((occurrence) => {
      if (occurrence.artifact_id === null)
        return {
          path: occurrence.logical_path,
          kind: occurrence.entry_kind,
          component: undefined,
        };
      const node = nodes.get(occurrence.artifact_id);
      if (node === undefined)
        throw new TypeError(
          "Apple application occurrence has no artifact node",
        );
      return {
        path: occurrence.logical_path,
        kind: occurrence.entry_kind,
        component: {
          path: occurrence.logical_path,
          artifact_id: node.artifact_id,
          sha256: node.sha256,
          format: occurrence.artifact_format,
        },
      };
    });
  const inventoried = entries.flatMap(({ component }) =>
    component === undefined ? [] : [component],
  );
  const roots = applicationRoots(entries, {
    name: evidence[0]?.subject?.name ?? "",
    format: rootFormat,
  });
  const { all, unattributed } = attributeComponents(
    inventoried,
    roots,
    rootFormat,
  );
  const bundles = detectBundles(entries, roots);
  const classified = classifyComponents(entries, all, roots);
  const runtimeFamilies = identifyRuntimeFamilies(all);
  const bridgeProjection = identifyBridgeCandidates(
    classified.javascript,
    deduplicateComponents([
      ...classified.executables,
      ...classified.native_libraries,
    ]),
    roots,
  );
  const uninventoriedImage =
    rootFormat === "dmg" && inventory.occurrences.length === 1;
  const complete = inventory.complete && !uninventoriedImage;
  const limitations = projectionLimitations({
    complete: inventory.complete,
    uninventoriedImage,
    roots,
    bundles,
    sidecars: entries.some(({ path }) => isSidecar(path)),
    symlinks: entries.some(({ kind }) => kind === "symlink"),
    unattributed,
    bridgeCandidateCoverage: bridgeProjection.coverage,
  });
  const withoutId = {
    root_sha256: inventory.manifest.root_sha256,
    root_format: rootFormat,
    platforms: platformsOf(bundles),
    source_evidence_ids: evidence
      .map(({ evidence_id: id }) => id)
      .sort(compare),
    application_roots: roots,
    bundles,
    components: classified,
    symlinks: entries
      .filter(({ kind }) => kind === "symlink")
      .map(({ path }) => path)
      .sort(compare),
    runtime_families: runtimeFamilies,
    bridge_candidates: bridgeProjection.candidates,
    bridge_candidate_coverage: bridgeProjection.coverage,
    coverage: {
      status:
        complete && bridgeProjection.coverage.status === "complete"
          ? ("complete-within-inventory" as const)
          : ("partial" as const),
      inventory_complete: inventory.complete,
    },
    limitations,
  };
  return appleApplicationProjectionResultSchema.parse({
    ...withoutId,
    projection_id: appleProjectionId(withoutId),
  });
};

/** Identify the complete projection, including source Evidence provenance. */
export const appleProjectionId = (projection: unknown): string =>
  `aap_${digest(projection)}`;

/**
 * IPA projection keeps every archive component, as before. Directory, ZIP,
 * and DMG inventories can hold installers and other siblings, so only
 * components inside an application root are attributed to it.
 */
const attributeComponents = (
  inventoried: readonly Component[],
  roots: readonly string[],
  rootFormat: RootFormat,
): { readonly all: Component[]; readonly unattributed: number } => {
  if (rootFormat === "ipa") return { all: [...inventoried], unattributed: 0 };
  const visible = inventoried.filter(({ path }) => !isSidecar(path));
  const all = visible.filter(({ path }) =>
    roots.some((root) => isWithin(path, root)),
  );
  return { all, unattributed: visible.length - all.length };
};

const appleRootFormat = (format: string): RootFormat => {
  const root = APPLE_ROOT_FORMATS.find((candidate) => candidate === format);
  if (root === undefined)
    throw new TypeError(
      `Apple application projection requires IPA, directory, ZIP, or DMG inventory Evidence (got ${format})`,
    );
  return root;
};

const classifyComponents = (
  entries: readonly AppleInventoryEntry[],
  all: readonly Component[],
  roots: readonly string[],
) => {
  const withinApp = (path: string): boolean =>
    roots.some((root) => isWithin(path, root));
  const anatomy = (pattern: RegExp): Component[] =>
    entries.flatMap(({ path, kind, component }) =>
      kind === "file" &&
      component !== undefined &&
      !isSidecar(path) &&
      withinApp(path) &&
      pattern.test(path)
        ? [component]
        : [],
    );
  return {
    bundle_metadata: all.filter(({ path }) =>
      /(?:^|\/)Info\.plist$/u.test(path),
    ),
    executables: all.filter(
      ({ path, format }) => withinApp(path) && isMachOFormat(format),
    ),
    frameworks: all.filter(({ path }) => /\.framework\//u.test(path)),
    native_libraries: all.filter(({ path }) => /\.(?:dylib|so)$/iu.test(path)),
    javascript: all.filter(({ format }) => format === "javascript-bundle"),
    signing: all.filter(({ path }) =>
      /(?:^|\/)(?:embedded\.(?:mobileprovision|provisionprofile)|_CodeSignature\/CodeResources)$/u.test(
        path,
      ),
    ),
    privileged_helpers: anatomy(
      /(?:^|\/)Contents\/Library\/LaunchServices\/[^/]+$/u,
    ),
    launchd_plists: anatomy(
      /(?:^|\/)Contents\/Library\/Launch(?:Agents|Daemons)\/[^/]+\.plist$/u,
    ).map((component) => ({
      ...component,
      domain: component.path.includes("/LaunchDaemons/")
        ? ("daemon" as const)
        : ("agent" as const),
    })),
    helpers: anatomy(/(?:^|\/)Contents\/Helpers\/[^/]+$/u),
  };
};

const deduplicateComponents = (values: readonly Component[]): Component[] =>
  [...new Map(values.map((value) => [value.path, value])).values()].sort(
    (left, right) => compare(left.path, right.path),
  );

const identifyRuntimeFamilies = (all: readonly Component[]) => {
  const families = new Set<
    z.infer<
      typeof appleApplicationProjectionResultSchema
    >["runtime_families"][number]
  >();
  if (all.some(({ format }) => ["mach-o", "mach-o-universal"].includes(format)))
    families.add("native");
  if (all.some(({ format }) => format === "javascript-bundle"))
    families.add("javascript");
  for (const { path } of all) {
    const family = frameworkConvention(path);
    if (family !== null) families.add(family);
  }
  return [...families].sort(compare);
};

/** Pair scripts and native code within matching application-root groups. */
const identifyBridgeCandidates = (
  scripts: readonly Component[],
  native: readonly Component[],
  roots: readonly string[],
) => {
  const owner = (path: string): string | null =>
    roots.find((root) => isWithin(path, root)) ?? null;
  const scriptGroups: { root: string | null; left: Component[] }[] = [];
  for (const script of scripts) {
    const root = owner(script.path);
    const last = scriptGroups.at(-1);
    if (last?.root === root) last.left.push(script);
    else scriptGroups.push({ root, left: [script] });
  }
  const nativeByRoot = new Map<string | null, Component[]>();
  for (const item of native) {
    const root = owner(item.path);
    const scoped = nativeByRoot.get(root) ?? [];
    scoped.push(item);
    nativeByRoot.set(root, scoped);
  }
  const groups = scriptGroups.map(({ root, left }) => ({
    left,
    right: nativeByRoot.get(root) ?? [],
  }));
  return projectCartesianCandidates({
    groups,
    createCandidate: (source_path, item) => ({
      source_path,
      native_path: item.path,
      basis: bridgeBasis(item.path),
    }),
  });
};

/** Match whole framework segments; generic App.framework does not identify Flutter. */
const frameworkConvention = (
  path: string,
): "react-native" | "flutter" | "unity" | null => {
  if (/(?:^|\/)(?:react|reactnative|hermes)\.framework(?:\/|$)/iu.test(path))
    return "react-native";
  if (/(?:^|\/)flutter\.framework(?:\/|$)/iu.test(path)) return "flutter";
  if (/(?:^|\/)unityframework\.framework(?:\/|$)/iu.test(path)) return "unity";
  return null;
};

const bridgeBasis = (
  path: string,
):
  | "javascript-and-native-content"
  | "react-native-convention"
  | "flutter-convention"
  | "unity-convention" => {
  const family = frameworkConvention(path);
  if (family !== null) return `${family}-convention`;
  return "javascript-and-native-content";
};

const projectionLimitations = (facts: {
  readonly complete: boolean;
  readonly uninventoriedImage: boolean;
  readonly roots: readonly string[];
  readonly bundles: readonly z.infer<typeof appleBundleSchema>[];
  readonly sidecars: boolean;
  readonly symlinks: boolean;
  readonly unattributed: number;
  readonly bridgeCandidateCoverage: AppleApplicationProjectionResult["bridge_candidate_coverage"];
}): string[] => [
  ...(!facts.complete
    ? ["Source inventory pages are incomplete; absence is unknown."]
    : []),
  ...(facts.uninventoriedImage
    ? [
        "The DMG's contents were not inventoried on this host; bundle absence is unknown.",
      ]
    : []),
  ...(facts.roots.length === 0
    ? [
        "No application bundle (Payload/*.app or *.app/Contents) was present in the supplied inventory pages.",
      ]
    : []),
  ...(facts.bundles.some(
    ({ layout, info_plist_path: plist }) =>
      layout === "versioned-framework" && plist === null,
  )
    ? [
        "A versioned framework has several version directories or no Versions/*/Resources/Info.plist; the Info.plist that Versions/Current selects is unknown because symlink targets are not inventoried.",
      ]
    : []),
  ...(facts.symlinks
    ? [
        "Symlinks are reported by path only; their targets are not inventoried, so bundles are reported at their real paths.",
      ]
    : []),
  ...(facts.unattributed > 0
    ? [
        `${facts.unattributed} inventoried entries outside every application root are not attributed to the application.`,
      ]
    : []),
  ...(facts.sidecars
    ? [
        "AppleDouble sidecar entries (._* files and __MACOSX/) describe neighbouring files and are excluded from bundle roles.",
      ]
    : []),
  ...(facts.bridgeCandidateCoverage.status === "partial"
    ? [
        `Bridge candidate pairs exceeded the projection safety budget; ${facts.bridgeCandidateCoverage.omitted_candidates} hypotheses are omitted. Component arrays still include every component from the supplied inventory pages.`,
      ]
    : []),
  "Bundle roles follow path conventions. Read each info_plist_path with inspect_plist for CFBundleExecutable, identifiers, and declared services.",
  "Bundle identifiers and signing claims require dedicated plist and CMS parsing; this projection reports only exact paths and hashes.",
  "Runtime families are inferred from inventory formats and bounded framework path conventions, not observed runtime loading.",
  "Generic framework and dylib paths do not establish Swift or Objective-C; this inventory projection does not decode language metadata.",
  "Bridge candidates are path-based hypotheses, not observed runtime calls.",
  "A bridge basis is inferred from the native path and is repeated for every managed component.",
];

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const digest = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Apple application projection is not canonical JSON");
  return createHash("sha256").update(encoded).digest("hex");
};
