import {
  bridgeCandidateCoverageSchema,
  projectCartesianCandidates,
} from "../bridgeCandidateProjection.js";
import { z } from "zod";
import { AnalysisInputError } from "../analysisErrorCore.js";

import {
  hasCompleteInventoryCoverage,
  type ParsedInventorySet,
} from "../artifactInventoryEvidence.js";
import { digestSchema, prefixedDigestSchema } from "../digests.js";
import { digestCanonicalValue } from "../canonicalDigest.js";
import { nativeRuntimeConvention } from "../nativeConvention.js";
import {
  projectedBridgeCandidateSchema,
  projectedComponentSchema,
  projectedInventoryEntries,
  projectedFileComponents,
  projectionCoverage,
  projectionEvidenceIdSchema,
  unavailableComponentSchema,
} from "../mobileApplicationGraphProjection.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { err, ok, type Result } from "../result.js";
import { isV1SignatureMetadataName } from "../apkSignature/apkV1MetadataName.js";

/** Deterministic, execution-free Android application inventory projection. */
export const androidApplicationProjectionResultSchema = z.strictObject({
  projection_id: prefixedDigestSchema("adp"),
  root_sha256: digestSchema,
  root_format: z.literal("apk"),
  source_evidence_ids: z.array(projectionEvidenceIdSchema).min(1),
  components: z.strictObject({
    manifests: z.array(projectedComponentSchema),
    resources: z.array(projectedComponentSchema),
    dex: z.array(projectedComponentSchema),
    jvm_classes: z.array(projectedComponentSchema),
    native_libraries: z.array(projectedComponentSchema),
    javascript: z.array(projectedComponentSchema),
    signing: z.array(projectedComponentSchema),
  }),
  unavailable_components: z.array(unavailableComponentSchema),
  runtime_families: z.array(
    z.enum([
      "dalvik-art",
      "java-kotlin",
      "native",
      "javascript",
      "react-native",
      "flutter",
      "unity",
    ]),
  ),
  bridge_candidates: z.array(
    projectedBridgeCandidateSchema([
      "managed-and-native-content",
      "jni-library-convention",
      "react-native-convention",
      "flutter-convention",
      "unity-convention",
    ] as const),
  ),
  bridge_candidate_coverage: bridgeCandidateCoverageSchema,
  coverage: z.strictObject({
    status: z.enum(["complete-within-inventory", "partial"]),
    // Count completeness is separate from the declared coverage status.
    inventory_complete: z.boolean(),
  }),
  limitations: z.array(z.string()),
});

export type AndroidApplicationProjectionResult = z.infer<
  typeof androidApplicationProjectionResultSchema
>;
type Component = z.infer<typeof projectedComponentSchema>;

/** Project exact APK paths and hashes without decoding or executing target code. */
export const projectAndroidInventory = (
  source: ParsedInventorySet,
): Result<AndroidApplicationProjectionResult, AnalysisInputError> => {
  const { evidence, inventory } = source;
  if (inventory.manifest.root_format !== "apk")
    return err(
      new AnalysisInputError("project_android_application_graph", {}, [
        {
          path: [
            "inventory_evidence",
            0,
            "normalized_result",
            "manifest",
            "root_format",
          ],
          reason: "invalid_value",
          message: `Android application projection requires APK inventory Evidence; the inventory root format is ${inventory.manifest.root_format}. APK is chosen for a ZIP archive whose name ends in .apk.`,
        },
      ]),
    );
  const { entries, limitations: unresolved } =
    projectedInventoryEntries(inventory);
  const all = projectedFileComponents(entries);
  const unavailable = entries.flatMap(({ unavailable }) =>
    unavailable === undefined ? [] : [unavailable],
  );
  const classified = classify(all);
  const bridgeProjection = bridgeCandidates(
    [...classified.dex, ...classified.jvm_classes],
    classified.native_libraries,
  );
  const components = classified;
  const limitations = [
    ...unresolved,
    ...inventory.limitations,
    ...(!hasCompleteInventoryCoverage(inventory, "container-entries")
      ? ["Source inventory coverage is partial; absence is unknown."]
      : []),
    "Manifest, resource, signing, and bytecode semantics require a dedicated Android provider; this projection reports exact inventory paths and hashes only.",
    "Runtime families are inferred from inventory formats and paths; filename suffixes do not establish valid DEX or JVM class bytes.",
    "Bridge candidates are path-based hypotheses, not decoded JNI declarations or observed runtime calls.",
    "A bridge basis is inferred from the native path and is repeated for every managed component.",
    "ZIP inventory cannot see the APK Signing Block, so an empty signing array does not mean the APK is unsigned.",
    ...(entries.some(
      ({ path, kind }) =>
        path === "AndroidManifest.xml" && (kind === "file" || kind === "slice"),
    )
      ? []
      : [
          "No root AndroidManifest.xml occurrence was observed. The APK family comes from the .apk suffix of a ZIP archive, so these bytes may not be an APK.",
        ]),
    ...(bridgeProjection.coverage.status === "partial"
      ? [
          `Bridge candidate pairs exceeded the projection safety budget; ${bridgeProjection.coverage.omitted_candidates} hypotheses are omitted. Component arrays still include every component from the supplied inventory pages.`,
        ]
      : []),
    ...(unavailable.length > 0
      ? [
          "Some inventoried occurrences have no authenticated content identity. Their paths and limitations are retained in unavailable_components; component absence is unknown.",
        ]
      : []),
  ];
  const withoutId = {
    root_sha256: inventory.manifest.root_sha256,
    root_format: "apk" as const,
    source_evidence_ids: evidence
      .map(({ evidence_id: id }) => id)
      .sort(compareUnicodeCodePoints),
    components,
    unavailable_components: unavailable,
    runtime_families: runtimeFamilies(all, classified),
    bridge_candidates: bridgeProjection.candidates,
    bridge_candidate_coverage: bridgeProjection.coverage,
    coverage: projectionCoverage(
      inventory,
      bridgeProjection.coverage.status === "complete" &&
        unavailable.length === 0,
    ),
    limitations,
  };
  return ok(
    androidApplicationProjectionResultSchema.parse({
      ...withoutId,
      projection_id: `adp_${digestCanonicalValue(withoutId, "Android application projection")}`,
    }),
  );
};

const ANDROID_MANIFEST_RE = /(?:^|\/)AndroidManifest\.xml$/u;
const ANDROID_RESOURCES_RE = /(?:^|\/)resources\.arsc$/u;
const ANDROID_DEX_RE = /(?:^|\/)[^/]+\.dex$/iu;
const ANDROID_JVM_CLASS_RE = /(?:^|\/)[^/]+\.class$/iu;
const ANDROID_NATIVE_LIB_RE = /(?:^|\/)lib\/[^/]+\/[^/]+\.so$/iu;

const classify = (all: readonly Component[]) => {
  const manifests: Component[] = [];
  const resources: Component[] = [];
  const dex: Component[] = [];
  const jvm_classes: Component[] = [];
  const native_libraries: Component[] = [];
  const javascript: Component[] = [];
  const signing: Component[] = [];
  for (const component of all) {
    const { path, format } = component;
    if (ANDROID_MANIFEST_RE.test(path)) manifests.push(component);
    if (ANDROID_RESOURCES_RE.test(path)) resources.push(component);
    if (ANDROID_DEX_RE.test(path)) dex.push(component);
    if (ANDROID_JVM_CLASS_RE.test(path)) jvm_classes.push(component);
    if (format === "elf" || ANDROID_NATIVE_LIB_RE.test(path))
      native_libraries.push(component);
    if (format === "javascript-bundle") javascript.push(component);
    if (isV1SignatureMetadataName(path)) signing.push(component);
  }
  return {
    manifests,
    resources,
    dex,
    jvm_classes,
    native_libraries,
    javascript,
    signing,
  };
};

const runtimeFamilies = (
  _all: readonly Component[],
  components: AndroidApplicationProjectionResult["components"],
) => {
  const families = new Set<
    AndroidApplicationProjectionResult["runtime_families"][number]
  >();
  if (components.dex.length > 0) families.add("dalvik-art");
  if (components.jvm_classes.length > 0) families.add("java-kotlin");
  if (components.javascript.length > 0) families.add("javascript");
  for (const { path, format } of components.native_libraries) {
    if (format === "elf") families.add("native");
    const convention = nativeRuntimeConvention(path);
    if (convention !== null) families.add(convention);
  }
  return [...families].sort(compareUnicodeCodePoints);
};

const bridgeCandidates = (
  managed: readonly Component[],
  native: readonly Component[],
) => {
  return projectCartesianCandidates({
    groups: [{ left: managed, right: native }],
    createCandidate: (managed_path, target) => ({
      managed_path,
      native_path: target.path,
      basis: bridgeBasis(target.path),
    }),
  });
};

const bridgeBasis = (
  path: string,
): AndroidApplicationProjectionResult["bridge_candidates"][number]["basis"] => {
  const convention = nativeRuntimeConvention(path);
  if (convention === "react-native") return "react-native-convention";
  if (convention === "flutter") return "flutter-convention";
  if (convention === "unity") return "unity-convention";
  if (/(?:^|\/)lib\/[^/]+\/lib[^/]+\.so$/iu.test(path))
    return "jni-library-convention";
  return "managed-and-native-content";
};
