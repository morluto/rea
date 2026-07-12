import { z } from "zod";

import type { BinaryTarget } from "./binaryTarget.js";
import { jsonValueSchema, type JsonValue } from "./jsonValue.js";

const artifactEvidenceSchema = z.object({
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  format: z.enum(["hopper", "mach-o", "elf", "pe"]),
  architecture: z.enum(["x86", "x86_64", "arm", "arm64"]).nullable(),
});

/** Strict JSON representation of one successful public analysis observation. */
export const evidenceSchema = z.object({
  schema_version: z.literal(1),
  artifact: artifactEvidenceSchema.nullable(),
  provider: z.object({ id: z.literal("hopper"), version: z.null() }),
  operation: z.string().min(1),
  parameters: z.record(z.string(), jsonValueSchema),
  result: jsonValueSchema,
  confidence: z.literal("observed"),
  limitations: z.array(z.string()),
});

export type Evidence = z.infer<typeof evidenceSchema>;

export interface EvidenceObservation {
  readonly operation: string;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly result: JsonValue;
  readonly limitations?: readonly string[];
}

/** Build deterministic evidence without claiming unavailable provider metadata. */
export const createEvidence = (
  target: BinaryTarget | undefined,
  observation: EvidenceObservation,
): Evidence =>
  evidenceSchema.parse({
    schema_version: 1,
    artifact:
      target === undefined
        ? null
        : {
            path: target.path,
            sha256: target.sha256,
            format: target.format,
            architecture: target.architecture ?? null,
          },
    provider: { id: "hopper", version: null },
    operation: observation.operation,
    parameters: observation.parameters,
    result: observation.result,
    confidence: "observed",
    limitations:
      target === undefined
        ? [
            "Artifact identity is unavailable for this fixed-target adapter.",
            ...(observation.limitations ?? []),
          ]
        : [...(observation.limitations ?? [])],
  });
