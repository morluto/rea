import { z } from "zod";

import { parseArtifactInventoryEvidence } from "../artifactInventoryEvidence.js";
import { digestSchema } from "../digests.js";
import { prefixedDigestSchema } from "../digests.js";
import { nativeRuntimeConvention } from "../nativeConvention.js";
import {
  applicationInventoryProjectionInputSchema,
  bridgeCandidateCoverageSchema,
  compareProjectionStrings,
  projectCartesianCandidates,
  projectedBridgeCandidateSchema,
  projectedComponentSchema,
  projectedComponents,
  projectionCoverage,
  projectionDigest,
  projectionEvidenceIdSchema,
} from "../mobileApplicationGraphProjection.js";

const evidenceIdSchema = projectionEvidenceIdSchema;
const componentSchema = projectedComponentSchema;

/** Authenticated APK inventory pages projected as one Android application. */
export const androidApplicationProjectionInputSchema =
  applicationInventoryProjectionInputSchema;

/** Deterministic, execution-free Android application inventory projection. */
export const androidApplicationProjectionResultSchema = z.strictObject({
  projection_id: prefixedDigestSchema("adp"),
  root_sha256: digestSchema,
  root_format: z.literal("apk"),
  source_evidence_ids: z.array(evidenceIdSchema).min(1),
  components: z.strictObject({
    manifests: z.array(componentSchema),
    resources: z.array(componentSchema),
    dex: z.array(componentSchema),
    jvm_classes: z.array(componentSchema),
    native_libraries: z.array(componentSchema),
    javascript: z.array(componentSchema),
    signing: z.array(componentSchema),
  }),
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
    inventory_complete: z.boolean(),
  }),
  limitations: z.array(z.string().min(1)),
});

export type AndroidApplicationProjectionInput = z.infer<
  typeof androidApplicationProjectionInputSchema
>;
export type AndroidApplicationProjectionResult = z.infer<
  typeof androidApplicationProjectionResultSchema
>;
type Component = z.infer<typeof componentSchema>;

/** Project exact APK paths and hashes without decoding or executing target code. */
export const projectAndroidApplication = (
  input: AndroidApplicationProjectionInput,
): AndroidApplicationProjectionResult => {
  const parsed = androidApplicationProjectionInputSchema.parse(input);
  const { evidence, inventory } = parseArtifactInventoryEvidence(
    parsed.inventory_evidence,
  );
  if (inventory.manifest.root_format !== "apk")
    throw new TypeError("Android application projection requires APK Evidence");
  const all = projectedComponents(inventory);
  const classified = classify(all);
  const bridgeProjection = bridgeCandidates(
    [...classified.dex, ...classified.jvm_classes],
    classified.native_libraries,
  );
  const components = classified;
  const limitations = [
    ...(!inventory.complete
      ? ["Source inventory pages are incomplete; absence is unknown."]
      : []),
    "Manifest, resource, signing, and bytecode semantics require a dedicated Android provider; this projection reports exact inventory paths and hashes only.",
    "Runtime families are inferred from inventory formats and paths; filename suffixes do not establish valid DEX or JVM class bytes.",
    "Bridge candidates are path-based hypotheses, not decoded JNI declarations or observed runtime calls.",
    "A bridge basis is inferred from the native path and is repeated for every managed component.",
    "ZIP inventory cannot see the APK Signing Block, so an empty signing array does not mean the APK is unsigned.",
    ...(bridgeProjection.coverage.status === "partial"
      ? [
          `Bridge candidate pairs exceeded the projection safety budget; ${bridgeProjection.coverage.omitted_candidates} hypotheses are omitted. Component arrays still include every component from the supplied inventory pages.`,
        ]
      : []),
  ];
  const withoutId = {
    root_sha256: inventory.manifest.root_sha256,
    root_format: "apk" as const,
    source_evidence_ids: evidence
      .map(({ evidence_id: id }) => id)
      .sort(compareProjectionStrings),
    components,
    runtime_families: runtimeFamilies(all),
    bridge_candidates: bridgeProjection.candidates,
    bridge_candidate_coverage: bridgeProjection.coverage,
    coverage: projectionCoverage(
      inventory,
      bridgeProjection.coverage.status === "complete",
    ),
    limitations,
  };
  return androidApplicationProjectionResultSchema.parse({
    ...withoutId,
    projection_id: `adp_${projectionDigest(withoutId, "Android application projection")}`,
  });
};

const classify = (all: readonly Component[]) => ({
  manifests: all.filter(({ path }) =>
    /(?:^|\/)AndroidManifest\.xml$/u.test(path),
  ),
  resources: all.filter(({ path }) => /(?:^|\/)resources\.arsc$/u.test(path)),
  dex: all.filter(({ path }) => /(?:^|\/)[^/]+\.dex$/iu.test(path)),
  jvm_classes: all.filter(({ path }) => /(?:^|\/)[^/]+\.class$/iu.test(path)),
  native_libraries: all.filter(
    ({ path, format }) =>
      format === "elf" || /(?:^|\/)lib\/[^/]+\/[^/]+\.so$/iu.test(path),
  ),
  javascript: all.filter(({ format }) => format === "javascript-bundle"),
  signing: all.filter(({ path }) =>
    /^META-INF\/[^/]+\.(?:MF|RSA|DSA|EC|SF)$/iu.test(path),
  ),
});

const runtimeFamilies = (all: readonly Component[]) => {
  const families = new Set<
    AndroidApplicationProjectionResult["runtime_families"][number]
  >();
  if (all.some(({ path }) => path.toLowerCase().endsWith(".dex")))
    families.add("dalvik-art");
  if (all.some(({ path }) => path.toLowerCase().endsWith(".class")))
    families.add("java-kotlin");
  if (all.some(({ format }) => format === "elf")) families.add("native");
  if (all.some(({ format }) => format === "javascript-bundle"))
    families.add("javascript");
  for (const { path } of all) {
    const convention = nativeRuntimeConvention(path);
    if (convention !== null) families.add(convention);
  }
  return [...families].sort(compareProjectionStrings);
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
  if (/lib\/[^/]+\/lib[^/]+\.so$/u.test(path.toLowerCase()))
    return "jni-library-convention";
  return "managed-and-native-content";
};
