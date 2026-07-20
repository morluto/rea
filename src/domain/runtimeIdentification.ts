import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import { parseArtifactInventoryEvidence } from "./artifactInventoryEvidence.js";
import { evidenceSchema } from "./evidence.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const runtimeFamilySchema = z.enum([
  "android",
  "apple",
  "javascript",
  "jvm",
  "native",
  "webassembly",
]);
const observationSchema = z.strictObject({
  path: z.string().min(1).max(4_096),
  artifact_id: z.string().regex(/^art_[a-f0-9]{64}$/u),
  sha256: digestSchema,
  format: z.string().min(1).max(100),
});

/** Authenticated artifact inventory pages to classify by runtime family. */
const runtimeIdentificationInputSchema = z.strictObject({
  inventory_evidence: z.array(evidenceSchema).min(1).max(100),
  limits: z
    .strictObject({
      max_observations: z.number().int().min(1).max(10_000).default(1_000),
    })
    .default({ max_observations: 1_000 }),
});

/** Provider-neutral runtime identification with explicit tooling availability. */
export const runtimeIdentificationResultSchema = z.strictObject({
  schema_version: z.literal(1),
  identification_id: z.string().regex(/^rid_[a-f0-9]{64}$/u),
  root_sha256: digestSchema,
  root_format: z.string().min(1).max(100),
  source_evidence_ids: z.array(evidenceIdSchema).min(1).max(100),
  runtimes: z.array(
    z.strictObject({
      family: runtimeFamilySchema,
      inspection: z.enum([
        "available",
        "provider-missing",
        "provider-selection-required",
      ]),
      provider_id: z.string().min(1).max(200).nullable(),
      reason: z.string().min(1).max(1_000).nullable(),
      observations: z.array(observationSchema),
      omitted_observations: z.number().int().min(0),
    }),
  ),
  coverage: z.strictObject({
    status: z.enum(["complete-within-inventory", "partial", "truncated"]),
    inventory_complete: z.boolean(),
    omitted_observations: z.number().int().min(0),
  }),
  limitations: z.array(z.string().min(1).max(4_096)).max(100),
});

export type RuntimeIdentificationInput = z.input<
  typeof runtimeIdentificationInputSchema
>;
export type RuntimeIdentificationResult = z.infer<
  typeof runtimeIdentificationResultSchema
>;
type RuntimeFamily = z.infer<typeof runtimeFamilySchema>;
type Observation = z.infer<typeof observationSchema>;
type RuntimeProvider = {
  readonly inspection:
    | "available"
    | "provider-missing"
    | "provider-selection-required";
  readonly id: string | null;
  readonly reason: string | null;
};

const PROVIDERS: Readonly<Record<RuntimeFamily, RuntimeProvider>> = {
  android: {
    inspection: "available",
    id: "rea-android-application",
    reason: null,
  },
  apple: { inspection: "available", id: "rea-apple-application", reason: null },
  javascript: {
    inspection: "available",
    id: "rea-javascript-application",
    reason: null,
  },
  jvm: {
    inspection: "provider-missing",
    id: null,
    reason: "Install or configure a JVM bytecode-analysis provider.",
  },
  native: {
    inspection: "provider-selection-required",
    id: null,
    reason:
      "Select an available native deep-analysis provider for this target and host.",
  },
  webassembly: {
    inspection: "provider-missing",
    id: null,
    reason: "Install or configure a WebAssembly semantic-analysis provider.",
  },
};

/** Identify runtime families without executing or semantically decoding target bytes. */
export const identifyRuntimes = (
  input: RuntimeIdentificationInput,
): RuntimeIdentificationResult => {
  const parsed = runtimeIdentificationInputSchema.parse(input);
  const { evidence, inventory } = parseArtifactInventoryEvidence(
    parsed.inventory_evidence,
  );
  const nodes = new Map(
    inventory.nodes.map((node) => [node.artifact_id, node]),
  );
  const grouped = new Map<RuntimeFamily, Observation[]>();
  const add = (family: RuntimeFamily, observation: Observation): void => {
    const observations = grouped.get(family) ?? [];
    observations.push(observation);
    grouped.set(family, observations);
  };
  for (const occurrence of inventory.occurrences) {
    if (occurrence.artifact_id === null) continue;
    const node = nodes.get(occurrence.artifact_id);
    if (node === undefined)
      throw new TypeError("Runtime observation has no artifact node");
    const observation = {
      path: occurrence.logical_path,
      artifact_id: node.artifact_id,
      sha256: node.sha256,
      format: node.format,
    };
    for (const family of familiesFor(node.format, occurrence.logical_path))
      add(family, observation);
  }
  const rootObservation = inventory.nodes.find(
    ({ sha256 }) => sha256 === inventory.manifest.root_sha256,
  );
  if (rootObservation !== undefined)
    for (const family of familiesFor(inventory.manifest.root_format, "."))
      add(family, {
        path: ".",
        artifact_id: rootObservation.artifact_id,
        sha256: rootObservation.sha256,
        format: rootObservation.format,
      });
  let remaining = parsed.limits.max_observations;
  let omitted = 0;
  const runtimes = [...grouped.entries()]
    .sort(([left], [right]) => compare(left, right))
    .map(([family, values]) => {
      const unique = deduplicate(values);
      const observations = unique.slice(0, remaining);
      remaining -= observations.length;
      const omittedObservations = unique.length - observations.length;
      omitted += omittedObservations;
      const provider = providerFor(family, inventory.manifest.root_format);
      return {
        family,
        inspection: provider.inspection,
        provider_id: provider.id,
        reason: provider.reason,
        observations,
        omitted_observations: omittedObservations,
      };
    });
  const limitations = [
    ...(!inventory.complete
      ? [
          "Source inventory pages are incomplete; absent runtimes remain unknown.",
        ]
      : []),
    ...(omitted > 0
      ? [`${String(omitted)} runtime observations were omitted by the limit.`]
      : []),
    "Runtime families are identified from exact artifact formats and paths; semantic claims require the named provider.",
  ];
  const withoutId = {
    schema_version: 1 as const,
    root_sha256: inventory.manifest.root_sha256,
    root_format: inventory.manifest.root_format,
    source_evidence_ids: evidence
      .map(({ evidence_id: id }) => id)
      .sort(compare),
    runtimes,
    coverage: {
      status:
        omitted > 0
          ? ("truncated" as const)
          : inventory.complete
            ? ("complete-within-inventory" as const)
            : ("partial" as const),
      inventory_complete: inventory.complete,
      omitted_observations: omitted,
    },
    limitations,
  };
  return runtimeIdentificationResultSchema.parse({
    ...withoutId,
    identification_id: `rid_${digest(withoutId)}`,
  });
};

const providerFor = (
  family: RuntimeFamily,
  rootFormat: string,
): RuntimeProvider =>
  family === "android" && rootFormat !== "apk"
    ? {
        inspection: "provider-selection-required",
        id: null,
        reason:
          "Extract or select an APK root before using the Android application provider.",
      }
    : PROVIDERS[family];

const familiesFor = (format: string, path: string): RuntimeFamily[] => {
  const families = new Set<RuntimeFamily>();
  if (
    format === "apk" ||
    format === "dex" ||
    /(?:^|\/)[^/]+\.dex$/iu.test(path) ||
    /(?:^|\/)AndroidManifest\.xml$/u.test(path)
  )
    families.add("android");
  if (format === "ipa") families.add("apple");
  if (format === "javascript-bundle") families.add("javascript");
  if (format === "jvm-class" || /(?:^|\/)[^/]+\.class$/iu.test(path))
    families.add("jvm");
  if (["elf", "mach-o", "mach-o-universal", "pe"].includes(format))
    families.add("native");
  if (format === "webassembly" || /(?:^|\/)[^/]+\.wasm$/iu.test(path))
    families.add("webassembly");
  return [...families];
};

const deduplicate = (values: readonly Observation[]): Observation[] =>
  [
    ...new Map(
      values.map((value) => [`${value.path}\0${value.artifact_id}`, value]),
    ).values(),
  ].sort((left, right) => compare(left.path, right.path));
const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const digest = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Runtime identification is not canonical JSON");
  return createHash("sha256").update(encoded).digest("hex");
};
