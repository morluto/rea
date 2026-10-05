import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import { parseArtifactInventoryEvidence } from "./artifactInventoryEvidence.js";
import { evidenceSchema } from "./evidence.js";
import { digestSchema } from "./../domain/digests.js";
import { prefixedDigestSchema } from "./../domain/digests.js";

const evidenceIdSchema = prefixedDigestSchema("ev");
const pathSchema = z.string().min(1);
const componentSchema = z.strictObject({
  path: pathSchema,
  artifact_id: prefixedDigestSchema("art"),
  sha256: digestSchema,
  format: z.string().min(1),
});

/** Authenticated APK inventory pages projected as one Android application. */
export const androidApplicationProjectionInputSchema = z.strictObject({
  inventory_evidence: z.array(evidenceSchema).min(1),
});

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
    z.strictObject({
      managed_path: pathSchema,
      native_path: pathSchema,
      basis: z.enum([
        "managed-and-native-content",
        "jni-library-convention",
        "react-native-convention",
        "flutter-convention",
        "unity-convention",
      ]),
    }),
  ),
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
          "Android application occurrence has no artifact node",
        );
      return {
        path: occurrence.logical_path,
        artifact_id: node.artifact_id,
        sha256: node.sha256,
        format: node.format,
      } satisfies Component;
    });
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
    "Bridge candidates are path-based hypotheses, not decoded JNI declarations or observed runtime calls.",
  ];
  const withoutId = {
    root_sha256: inventory.manifest.root_sha256,
    root_format: "apk" as const,
    source_evidence_ids: evidence
      .map(({ evidence_id: id }) => id)
      .sort(compare),
    components,
    runtime_families: runtimeFamilies(all),
    bridge_candidates: bridgeProjection.candidates,
    coverage: {
      status: inventory.complete
        ? ("complete-within-inventory" as const)
        : ("partial" as const),
      inventory_complete: inventory.complete,
    },
    limitations,
  };
  return androidApplicationProjectionResultSchema.parse({
    ...withoutId,
    projection_id: `adp_${digest(withoutId)}`,
  });
};

const classify = (all: readonly Component[]) => ({
  manifests: all.filter(
    ({ path, format }) =>
      format === "android-manifest" ||
      /(?:^|\/)AndroidManifest\.xml$/u.test(path),
  ),
  resources: all.filter(
    ({ path, format }) =>
      format === "android-resources" || /(?:^|\/)resources\.arsc$/u.test(path),
  ),
  dex: all.filter(
    ({ path, format }) =>
      format === "dex" || /(?:^|\/)[^/]+\.dex$/iu.test(path),
  ),
  jvm_classes: all.filter(
    ({ path, format }) =>
      format === "jvm-class" || /(?:^|\/)[^/]+\.class$/iu.test(path),
  ),
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
  const paths = all.map(({ path }) => path.toLowerCase());
  const families = new Set<
    AndroidApplicationProjectionResult["runtime_families"][number]
  >();
  if (all.some(({ path, format }) => format === "dex" || path.endsWith(".dex")))
    families.add("dalvik-art");
  if (
    all.some(
      ({ path, format }) => format === "jvm-class" || path.endsWith(".class"),
    )
  )
    families.add("java-kotlin");
  if (all.some(({ format }) => format === "elf")) families.add("native");
  if (all.some(({ format }) => format === "javascript-bundle"))
    families.add("javascript");
  if (
    paths.some(
      (path) => path.includes("reactnative") || path.includes("hermes"),
    )
  )
    families.add("react-native");
  if (paths.some((path) => path.includes("libflutter.so")))
    families.add("flutter");
  if (paths.some((path) => path.includes("libunity.so"))) families.add("unity");
  return [...families].sort(compare);
};

const bridgeCandidates = (
  managed: readonly Component[],
  native: readonly Component[],
) => {
  const candidates = managed.flatMap((source) =>
    native.map((target) => ({
      managed_path: source.path,
      native_path: target.path,
      basis: bridgeBasis(target.path),
    })),
  );
  return {
    candidates,
  };
};

const bridgeBasis = (
  path: string,
): AndroidApplicationProjectionResult["bridge_candidates"][number]["basis"] => {
  const lower = path.toLowerCase();
  if (lower.includes("react") || lower.includes("hermes"))
    return "react-native-convention";
  if (lower.includes("flutter")) return "flutter-convention";
  if (lower.includes("unity")) return "unity-convention";
  if (/lib\/[^/]+\/lib[^/]+\.so$/u.test(lower)) return "jni-library-convention";
  return "managed-and-native-content";
};

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const digest = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Android application projection is not canonical JSON");
  return createHash("sha256").update(encoded).digest("hex");
};
