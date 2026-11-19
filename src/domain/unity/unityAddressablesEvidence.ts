import {
  createEvidence,
  type Evidence,
  type EvidenceProvider,
} from "../evidence.js";
import type {
  UnityAddressables,
  UnityAddressablesProviderInput,
} from "./unityAddressables.js";

/** One catalog Evidence shape for complete results and for decoded rows kept after a hash failure. */
export const unityAddressablesCatalogEvidence = (
  value: UnityAddressables,
  provider: EvidenceProvider,
  input: UnityAddressablesProviderInput,
  extraLimitations: readonly string[] = [],
): Evidence =>
  createEvidence(
    {
      path: value.artifact.path,
      sha256: value.artifact.sha256,
      format: "file",
    },
    provider,
    {
      operation: "inspect_unity_addressables",
      parameters: Object.fromEntries(
        Object.entries(input).filter(([, item]) => item !== undefined),
      ) as Record<string, string>,
      result: value,
      // JSON dependencies are resolved through keys; everything else is read as stored.
      confidence: value.format === "json" ? "derived" : "observed",
      limitations: [...value.limitations, ...extraLimitations],
      locations: [
        { kind: "artifact-path", path: value.artifact.path },
        ...(value.hash_file === null
          ? []
          : [
              {
                kind: "artifact-path" as const,
                path: value.hash_file.artifact.path,
              },
            ]),
      ],
    },
  );
