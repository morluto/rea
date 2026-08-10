import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import { evidenceEnvelopeSchema } from "./evidence.js";
import { evidenceBundleSchema } from "./evidenceBundle.js";
import { err, ok, type Result } from "./result.js";

/** Schema version for the conformance package format. */
export const CONFORMANCE_PACKAGE_VERSION = 1;

const conformancePackageIdSchema = z.string().regex(/^cp_[a-f0-9]{64}$/u);

const scenarioIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,99}$/u);

const scenarioManifestSchema = z.strictObject({
  scenario_id: scenarioIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  /** Source-owned fixture path relative to the repository root. */
  fixture_path: z.string().min(1),
  /** Expected exit code or null if unspecified. */
  expected_exit_code: z.number().int().nullable(),
  /** Expected output patterns that must appear in the capture. */
  expected_patterns: z.array(z.string()).default([]),
});

const replayPlanSchema = z.strictObject({
  scenario_id: scenarioIdSchema,
  /** Ordered steps to execute during replay. */
  steps: z
    .array(
      z.strictObject({
        step_id: z.string().min(1),
        action: z.string().min(1),
        arguments: z.array(z.string()).default([]),
        timeout_ms: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(100),
  /** Environment variables to set (never inherit host paths). */
  environment: z.record(z.string(), z.string()).default({}),
});

const shimPlanSchema = z.strictObject({
  scenario_id: scenarioIdSchema,
  /** Shims to install, each intercepting a named effect. */
  shims: z
    .array(
      z.strictObject({
        shim_id: z.string().min(1),
        kind: z.enum(["filesystem", "network", "process", "signal"]),
        target: z.string().min(1),
        policy: z.enum(["observe", "allow", "block", "emulate"]),
      }),
    )
    .max(50),
});

const expectedEvidenceSchema = z.strictObject({
  scenario_id: scenarioIdSchema,
  /** Expected evidence envelopes. */
  envelopes: z.array(evidenceEnvelopeSchema).max(100),
  /** Expected evidence bundle. */
  bundle: evidenceBundleSchema.nullable(),
  /** Required dimensions that must be present in the evidence. */
  required_dimensions: z.array(z.string().min(1)).default([]),
});

const verifierContractSchema = z.strictObject({
  scenario_id: scenarioIdSchema,
  /** Dimensions to verify. */
  dimensions: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        required: z.boolean().default(true),
        comparison: z.enum(["exact", "semantic", "fuzzy"]),
      }),
    )
    .min(1)
    .max(50),
  /** Tolerance for timing differences in milliseconds. */
  timing_tolerance_ms: z.number().int().nonnegative().default(0),
});

const conformancePackageContentsSchema = z.strictObject({
  schema_version: z.literal(CONFORMANCE_PACKAGE_VERSION),
  name: z.string().min(1),
  description: z.string().min(1),
  created_at: z.string().datetime(),
  /** Scenario manifests. */
  scenarios: z.array(scenarioManifestSchema).min(1).max(100),
  /** Exactly one replay plan for each scenario. */
  replay_plans: z.array(replayPlanSchema).min(1).max(100),
  /** At most one optional shim plan for each scenario. */
  shim_plans: z.array(shimPlanSchema).default([]),
  /** Exactly one expected-evidence record for each scenario. */
  expected_evidence: z.array(expectedEvidenceSchema).min(1).max(100),
  /** Exactly one verifier contract for each scenario. */
  verifier_contracts: z.array(verifierContractSchema).min(1).max(100),
});

const conformancePackageRecordSchema = conformancePackageContentsSchema.extend({
  package_id: conformancePackageIdSchema,
});

const conformancePackageSchema =
  conformancePackageRecordSchema.brand<"ConformancePackage">();

type ConformancePackageContents = z.output<
  typeof conformancePackageContentsSchema
>;
type ConformancePackageRecord = z.output<typeof conformancePackageRecordSchema>;
type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

/** Source fields accepted by the conformance-package smart constructor. */
export type ConformancePackageInput = DeepReadonly<
  z.input<typeof conformancePackageContentsSchema>
>;

/** A shape- and relation-checked, content-addressed conformance package. */
export type ConformancePackage = DeepReadonly<
  z.output<typeof conformancePackageSchema>
>;

/** Deterministic manifest for one conformance scenario. */
export type ScenarioManifest = DeepReadonly<
  z.output<typeof scenarioManifestSchema>
>;

/** Deterministic replay plan for one conformance scenario. */
export type ReplayPlan = DeepReadonly<z.output<typeof replayPlanSchema>>;

/** Optional effect-shim plan for one conformance scenario. */
export type ShimPlan = DeepReadonly<z.output<typeof shimPlanSchema>>;

/** Expected evidence for one conformance scenario. */
export type ExpectedEvidence = DeepReadonly<
  z.output<typeof expectedEvidenceSchema>
>;

/** Verification policy for one conformance scenario. */
export type VerifierContract = DeepReadonly<
  z.output<typeof verifierContractSchema>
>;

/** Per-scenario package section participating in relation checks. */
export type ConformancePackageSection =
  | "replay_plans"
  | "shim_plans"
  | "expected_evidence"
  | "verifier_contracts";

/** Precise reason an unknown package could not become a domain value. */
export type ConformancePackageError =
  | {
      readonly kind: "invalid_package";
      readonly message: string;
    }
  | {
      readonly kind: "duplicate_scenario";
      readonly scenario_id: string;
      readonly message: string;
    }
  | {
      readonly kind: "unknown_scenario_reference";
      readonly section: ConformancePackageSection;
      readonly scenario_id: string;
      readonly message: string;
    }
  | {
      readonly kind: "duplicate_scenario_reference";
      readonly section: ConformancePackageSection;
      readonly scenario_id: string;
      readonly message: string;
    }
  | {
      readonly kind: "missing_scenario_reference";
      readonly section: Exclude<ConformancePackageSection, "shim_plans">;
      readonly scenario_id: string;
      readonly message: string;
    }
  | {
      readonly kind: "package_id_mismatch";
      readonly actual: string;
      readonly expected: string;
      readonly message: string;
    };

type ScenarioReferenceSection =
  | {
      readonly name: Exclude<ConformancePackageSection, "shim_plans">;
      readonly entries: readonly { readonly scenario_id: string }[];
      readonly required: true;
    }
  | {
      readonly name: "shim_plans";
      readonly entries: readonly { readonly scenario_id: string }[];
      readonly required: false;
    };

/** Parse unknown input once into a package whose aggregate invariants hold. */
export function parseConformancePackage(
  input: unknown,
): Result<ConformancePackage, ConformancePackageError> {
  const parsed = conformancePackageSchema.safeParse(input);
  if (!parsed.success)
    return err({
      kind: "invalid_package",
      message: parsed.error.issues[0]?.message ?? "Invalid package",
    });

  const relationError = parseScenarioRelations(parsed.data);
  if (relationError !== undefined) return err(relationError);

  const expectedPackageId = computePackageId(packageContents(parsed.data));
  if (parsed.data.package_id !== expectedPackageId)
    return err({
      kind: "package_id_mismatch",
      actual: parsed.data.package_id,
      expected: expectedPackageId,
      message: "Package identifier does not match its canonical contents",
    });

  return ok(parsed.data);
}

/** Create a content-addressed package from source-owned typed fields. */
export function createConformancePackage(
  input: ConformancePackageInput,
): ConformancePackage {
  const contents = conformancePackageContentsSchema.safeParse(input);
  if (!contents.success)
    throw new TypeError(
      `Invalid conformance package source: ${contents.error.issues[0]?.message ?? "unknown parse failure"}`,
    );

  const parsed = parseConformancePackage({
    ...contents.data,
    package_id: computePackageId(contents.data),
  });
  if (!parsed.ok)
    throw new TypeError(
      `Invalid conformance package source: ${parsed.error.message}`,
    );
  return parsed.value;
}

const parseScenarioRelations = (
  pkg: ConformancePackageRecord,
): ConformancePackageError | undefined => {
  const scenarioIds = new Set<string>();
  for (const scenario of pkg.scenarios) {
    if (scenarioIds.has(scenario.scenario_id))
      return {
        kind: "duplicate_scenario",
        scenario_id: scenario.scenario_id,
        message: `Duplicate scenario ${scenario.scenario_id}`,
      };
    scenarioIds.add(scenario.scenario_id);
  }

  const sections: readonly ScenarioReferenceSection[] = [
    { name: "replay_plans", entries: pkg.replay_plans, required: true },
    { name: "shim_plans", entries: pkg.shim_plans, required: false },
    {
      name: "expected_evidence",
      entries: pkg.expected_evidence,
      required: true,
    },
    {
      name: "verifier_contracts",
      entries: pkg.verifier_contracts,
      required: true,
    },
  ];
  for (const section of sections) {
    const error = parseScenarioSection(scenarioIds, section);
    if (error !== undefined) return error;
  }
  return undefined;
};

const parseScenarioSection = (
  scenarioIds: ReadonlySet<string>,
  section: ScenarioReferenceSection,
): ConformancePackageError | undefined => {
  const referenced = new Set<string>();
  for (const entry of section.entries) {
    if (!scenarioIds.has(entry.scenario_id))
      return {
        kind: "unknown_scenario_reference",
        section: section.name,
        scenario_id: entry.scenario_id,
        message: `${section.name} references unknown scenario ${entry.scenario_id}`,
      };
    if (referenced.has(entry.scenario_id))
      return {
        kind: "duplicate_scenario_reference",
        section: section.name,
        scenario_id: entry.scenario_id,
        message: `${section.name} contains duplicate scenario ${entry.scenario_id}`,
      };
    referenced.add(entry.scenario_id);
  }

  if (!section.required) return undefined;
  for (const scenarioId of scenarioIds) {
    if (!referenced.has(scenarioId))
      return {
        kind: "missing_scenario_reference",
        section: section.name,
        scenario_id: scenarioId,
        message: `${section.name} is missing scenario ${scenarioId}`,
      };
  }
  return undefined;
};

const packageContents = (
  pkg: ConformancePackageRecord,
): ConformancePackageContents => ({
  schema_version: pkg.schema_version,
  name: pkg.name,
  description: pkg.description,
  created_at: pkg.created_at,
  scenarios: pkg.scenarios,
  replay_plans: pkg.replay_plans,
  shim_plans: pkg.shim_plans,
  expected_evidence: pkg.expected_evidence,
  verifier_contracts: pkg.verifier_contracts,
});

const computePackageId = (contents: ConformancePackageContents): string => {
  const json = canonicalize(contents);
  if (json === undefined)
    throw new TypeError("Could not canonicalize parsed conformance package");
  return `cp_${createHash("sha256").update(json).digest("hex")}`;
};
