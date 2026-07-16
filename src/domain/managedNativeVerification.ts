import { createHash } from "node:crypto";
import { basename } from "node:path";

import canonicalize from "canonicalize";
import { z } from "zod";

import { evidenceSchema, parseEvidence } from "./evidence.js";
import { functionDossierSchema } from "./hopperValues.js";
import {
  managedNativeBoundaryInspectionSchema,
  type ManagedNativeBoundaryInspection,
} from "./managedArtifact.js";
import { inspectMachoSchema } from "./nativeInspection.js";
import type { JsonValue } from "./jsonValue.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const tokenSchema = z.string().regex(/^0x[0-9a-f]{8}$/u);
const boundedTextSchema = z.string().min(1).max(4_096);

const nativeVerificationLimitsSchema = z.strictObject({
  max_native_observations: z.number().int().min(1).max(50).default(20),
  max_candidates_per_import: z.number().int().min(1).max(100).default(25),
});

/** Authenticated managed boundary Evidence plus native observations. */
export const managedNativeVerificationInputSchema = z
  .strictObject({
    managed_boundaries: evidenceSchema,
    native_observations: z.array(evidenceSchema).min(1).max(50),
    limits: nativeVerificationLimitsSchema.default({
      max_native_observations: 20,
      max_candidates_per_import: 25,
    }),
    unknown_registry_approved: z.literal(true).optional(),
  })
  .superRefine((input, context) => {
    const ids = new Set<string>();
    for (const [index, evidence] of input.native_observations.entries()) {
      if (evidence.evidence_id === input.managed_boundaries.evidence_id) {
        context.addIssue({
          code: "custom",
          path: ["native_observations", index],
          message:
            "Native observation Evidence must be distinct from managed boundary Evidence",
        });
      }
      if (ids.has(evidence.evidence_id)) {
        context.addIssue({
          code: "custom",
          path: ["native_observations", index],
          message: "Native observation Evidence IDs must be unique",
        });
      }
      ids.add(evidence.evidence_id);
    }
  });

const nativeSymbolSchema = z.strictObject({
  evidence_id: evidenceIdSchema,
  operation: z.string().min(1),
  name: z.string().min(1),
  address: z.string().nullable(),
  module_name: z.string().nullable(),
  module_path: z.string().nullable(),
  source: z.enum(["macho-export", "function-dossier"]),
});

const matchStatusSchema = z.enum([
  "verified",
  "inferred",
  "unresolved",
  "contradicted",
]);

const matchBasisSchema = z.enum([
  "exact-export-name",
  "exact-function-name",
  "decorated-name-candidate",
  "module-mismatch",
  "no-native-candidate",
  "unsupported-native-evidence",
]);

const pinvokeVerificationSchema = z.strictObject({
  item_id: z.string().regex(/^mnv_pinvoke_[a-f0-9]{64}$/u),
  managed: z.strictObject({
    token: tokenSchema,
    member_token: tokenSchema.nullable(),
    member_name: z.string().nullable(),
    import_name: z.string().min(1),
    import_scope_name: z.string().nullable(),
    no_mangle: z.boolean(),
    char_set: z.enum(["not-specified", "ansi", "unicode", "auto", "unknown"]),
    call_convention: z.enum([
      "not-specified",
      "winapi",
      "cdecl",
      "stdcall",
      "thiscall",
      "fastcall",
      "unknown",
    ]),
    declaration_verification: z.literal("managed-declaration-only"),
  }),
  status: matchStatusSchema,
  basis: matchBasisSchema,
  confidence: z.enum(["observed", "inferred", "unknown"]),
  matched_native: nativeSymbolSchema.nullable(),
  candidates: z.array(nativeSymbolSchema).max(100),
  evidence_links: z.array(evidenceIdSchema).min(1).max(51),
  limitations: z.array(boundedTextSchema).max(100),
});

/** Provider-neutral managed/native verification result. */
export const managedNativeVerificationResultSchema = z.strictObject({
  schema_version: z.literal(1),
  verification_id: z.string().regex(/^mnv_[a-f0-9]{64}$/u),
  algorithm: z.strictObject({
    name: z.literal("rea-managed-native-verification"),
    version: z.literal(1),
    token_identity: z.literal("build-local"),
    token_to_address_mapping: z.literal("not-inferred"),
  }),
  managed_boundary: z.strictObject({
    evidence_id: evidenceIdSchema,
    artifact_sha256: digestSchema,
    artifact_path: z.string().min(1),
    mvid: z.string().uuid().nullable(),
    metadata_status: z.enum(["absent", "complete", "partial", "malformed"]),
    pinvoke_imports_total: z.number().int().min(0),
    native_implementations_total: z.number().int().min(0),
    coverage_state: z.enum(["complete", "partial", "unavailable"]),
  }),
  native_observations: z.strictObject({
    total: z.number().int().min(1),
    accepted: z.number().int().min(0),
    unsupported: z.number().int().min(0),
    symbols: z.number().int().min(0),
    truncated: z.boolean(),
  }),
  summary: z.strictObject({
    verified: z.number().int().min(0),
    inferred: z.number().int().min(0),
    unresolved: z.number().int().min(0),
    contradicted: z.number().int().min(0),
    native_body_unresolved: z.number().int().min(0),
  }),
  pinvoke_imports: z.array(pinvokeVerificationSchema).max(50_000),
  native_implementations: z.strictObject({
    unresolved: z.number().int().min(0),
    reason: boundedTextSchema,
  }),
  coverage: z.strictObject({
    status: z.enum(["complete-within-inputs", "partial", "truncated"]),
    omitted_native_observations: z.number().int().min(0),
    omitted_candidates: z.number().int().min(0),
  }),
  evidence_links: z.array(evidenceIdSchema).min(2).max(51),
  limitations: z.array(boundedTextSchema).max(1_000),
});

export type ManagedNativeVerificationInput = z.infer<
  typeof managedNativeVerificationInputSchema
>;
export type ManagedNativeVerificationResult = z.infer<
  typeof managedNativeVerificationResultSchema
>;

type NativeSymbol = z.infer<typeof nativeSymbolSchema>;
type PinvokeImport =
  ManagedNativeBoundaryInspection["pinvoke_imports"]["items"][number];
type PinvokeVerification = z.infer<typeof pinvokeVerificationSchema>;
type VerifiedPinvoke = {
  readonly verification: PinvokeVerification;
  readonly omittedCandidates: number;
};

const sha256 = (value: JsonValue): string => {
  const serialized = canonicalize(value);
  if (serialized === undefined)
    throw new TypeError("Managed/native verification canonicalization failed");
  return createHash("sha256").update(serialized).digest("hex");
};

/** Verify managed P/Invoke declarations against authenticated native Evidence. */
export const verifyManagedNativeBoundaries = (
  input: ManagedNativeVerificationInput,
): ManagedNativeVerificationResult => {
  const managedEvidence = parseEvidence(input.managed_boundaries);
  if (managedEvidence.operation !== "inspect_managed_native_boundaries")
    throw new TypeError(
      "Evidence operation is not inspect_managed_native_boundaries",
    );
  const managed = managedNativeBoundaryInspectionSchema.parse(
    managedEvidence.normalized_result,
  );
  const native = collectNativeSymbols(
    input.native_observations.slice(0, input.limits.max_native_observations),
  );
  const verifiedPinvokes = managed.pinvoke_imports.items.map((item) =>
    verifyPinvoke(
      item,
      managedEvidence.evidence_id,
      native.symbols,
      native.accepted > 0,
      input,
    ),
  );
  const pinvokeImports = verifiedPinvokes.map(
    ({ verification }) => verification,
  );
  const counts = countStatuses(pinvokeImports);
  const omittedNativeObservations = Math.max(
    0,
    input.native_observations.length - input.limits.max_native_observations,
  );
  const omittedCandidates = verifiedPinvokes.reduce(
    (sum, item) => sum + item.omittedCandidates,
    0,
  );
  const coverageStatus =
    omittedNativeObservations > 0 || omittedCandidates > 0
      ? "truncated"
      : managed.coverage.state === "complete" && native.unsupported === 0
        ? "complete-within-inputs"
        : "partial";
  const withoutId = {
    schema_version: 1 as const,
    algorithm: {
      name: "rea-managed-native-verification" as const,
      version: 1 as const,
      token_identity: "build-local" as const,
      token_to_address_mapping: "not-inferred" as const,
    },
    managed_boundary: {
      evidence_id: managedEvidence.evidence_id,
      artifact_sha256: managed.artifact.sha256,
      artifact_path: managed.artifact.path,
      mvid: managed.module?.mvid ?? null,
      metadata_status: managed.metadata.status,
      pinvoke_imports_total: managed.pinvoke_imports.total,
      native_implementations_total: managed.native_implementations.total,
      coverage_state: managed.coverage.state,
    },
    native_observations: {
      total: input.native_observations.length,
      accepted: native.accepted,
      unsupported: native.unsupported,
      symbols: native.symbols.length,
      truncated: omittedNativeObservations > 0,
    },
    summary: {
      ...counts,
      native_body_unresolved: managed.native_implementations.items.filter(
        ({ boundary_kind: kind }) => kind !== "pinvoke",
      ).length,
    },
    pinvoke_imports: pinvokeImports,
    native_implementations: {
      unresolved: managed.native_implementations.items.filter(
        ({ boundary_kind: kind }) => kind !== "pinvoke",
      ).length,
      reason:
        "Managed metadata tokens and RVAs are not translated to native provider addresses by this workflow; C++/CLI, ReadyToRun, and native-body mappings require explicit provider-supported bridge evidence.",
    },
    coverage: {
      status: coverageStatus,
      omitted_native_observations: omittedNativeObservations,
      omitted_candidates: omittedCandidates,
    },
    evidence_links: [
      managedEvidence.evidence_id,
      ...input.native_observations
        .slice(0, input.limits.max_native_observations)
        .map(({ evidence_id: id }) => id),
    ],
    limitations: [
      "P/Invoke verification checks declared import names against supplied native export or function-name Evidence only.",
      "A matching native symbol verifies that a candidate export/function was observed; it does not prove CLR binding, marshaling behavior, call reachability, or runtime loading.",
      "Missing supplied native symbols are reported as unresolved, not proof that a dependency cannot exist.",
      "Managed metadata tokens and method RVAs are not interpreted as native addresses.",
      ...(managed.coverage.state === "complete"
        ? []
        : ["Managed boundary input is partial or unavailable."]),
      ...(native.unsupported === 0
        ? []
        : [
            "Some native Evidence operations were unsupported by this workflow.",
          ]),
    ],
  };
  return managedNativeVerificationResultSchema.parse({
    ...withoutId,
    verification_id: `mnv_${sha256(withoutId)}`,
  });
};

const collectNativeSymbols = (
  observations: readonly ManagedNativeVerificationInput["native_observations"][number][],
): {
  readonly symbols: readonly NativeSymbol[];
  readonly accepted: number;
  readonly unsupported: number;
} => {
  const symbols: NativeSymbol[] = [];
  let accepted = 0;
  let unsupported = 0;
  for (const raw of observations) {
    const evidence = parseEvidence(raw);
    const extracted = symbolsForEvidence(evidence);
    if (!extracted.supported) {
      unsupported += 1;
    } else {
      accepted += 1;
      symbols.push(...extracted.symbols);
    }
  }
  return { symbols, accepted, unsupported };
};

const symbolsForEvidence = (
  evidence: ReturnType<typeof parseEvidence>,
): {
  readonly supported: boolean;
  readonly symbols: readonly NativeSymbol[];
} => {
  if (evidence.operation === "inspect_macho") {
    const result = inspectMachoSchema.parse(evidence.normalized_result);
    return {
      supported: true,
      symbols: result.exports.items.map((symbol) => ({
        evidence_id: evidence.evidence_id,
        operation: evidence.operation,
        name: symbol.name,
        address: symbol.address,
        module_name: moduleName(evidence),
        module_path: modulePath(evidence),
        source: "macho-export" as const,
      })),
    };
  }
  if (evidence.operation === "analyze_function") {
    const dossier = functionDossierSchema.parse(evidence.normalized_result);
    return {
      supported: true,
      symbols: [
        {
          evidence_id: evidence.evidence_id,
          operation: evidence.operation,
          name: dossier.procedure.name,
          address: dossier.procedure.address,
          module_name: moduleName(evidence),
          module_path: modulePath(evidence),
          source: "function-dossier" as const,
        },
      ],
    };
  }
  return { supported: false, symbols: [] };
};

const verifyPinvoke = (
  item: PinvokeImport,
  managedEvidenceId: string,
  symbols: readonly NativeSymbol[],
  hasSupportedNativeEvidence: boolean,
  input: ManagedNativeVerificationInput,
): VerifiedPinvoke => {
  const managed = {
    token: item.token,
    member_token: item.member_token,
    member_name: item.member_name,
    import_name: item.import_name,
    import_scope_name: item.import_scope_name,
    no_mangle: item.no_mangle,
    char_set: item.char_set,
    call_convention: item.call_convention,
    declaration_verification: item.verification,
  };
  const names = candidateNames(managed);
  const allCandidates = symbols.filter((symbol) =>
    names.some((name) => sameSymbolName(name, symbol.name)),
  );
  const candidates = allCandidates.slice(
    0,
    input.limits.max_candidates_per_import,
  );
  const exact = candidates.find(
    (symbol) =>
      sameSymbolName(item.import_name, symbol.name) &&
      moduleCompatible(item.import_scope_name, symbol),
  );
  const decorated = candidates.find((symbol) =>
    moduleCompatible(item.import_scope_name, symbol),
  );
  const selected = exact ?? decorated ?? candidates[0] ?? null;
  const basis =
    selected === null
      ? hasSupportedNativeEvidence
        ? "no-native-candidate"
        : "unsupported-native-evidence"
      : !moduleCompatible(item.import_scope_name, selected)
        ? "module-mismatch"
        : exact !== undefined
          ? selected.source === "macho-export"
            ? "exact-export-name"
            : "exact-function-name"
          : "decorated-name-candidate";
  const status =
    selected === null
      ? "unresolved"
      : basis === "module-mismatch"
        ? "contradicted"
        : basis === "decorated-name-candidate"
          ? "inferred"
          : "verified";
  const limitations = [
    ...(item.import_scope_name === null
      ? ["Managed declaration does not name an import scope/module."]
      : []),
    ...(status === "inferred"
      ? [
          "Native symbol matched a decorated candidate rather than the exact declared import name.",
        ]
      : []),
    ...(status === "contradicted"
      ? [
          "A symbol name candidate exists, but the supplied native Evidence module identity does not match the managed import scope.",
        ]
      : []),
    ...(status === "unresolved"
      ? [
          "No supplied native export/function Evidence matched this declared import.",
        ]
      : []),
  ];
  return {
    verification: pinvokeVerificationSchema.parse({
      item_id: `mnv_pinvoke_${sha256({
        managedEvidenceId,
        token: item.token,
        importName: item.import_name,
        importScope: item.import_scope_name,
        candidates,
      })}`,
      managed,
      status,
      basis,
      confidence:
        status === "verified"
          ? "observed"
          : status === "inferred"
            ? "inferred"
            : "unknown",
      matched_native: selected,
      candidates,
      evidence_links: [
        managedEvidenceId,
        ...new Set(candidates.map(({ evidence_id: id }) => id)),
      ],
      limitations,
    }),
    omittedCandidates: Math.max(0, allCandidates.length - candidates.length),
  };
};

const candidateNames = (
  managed: Pick<
    PinvokeImport,
    "import_name" | "char_set" | "call_convention" | "no_mangle"
  >,
): readonly string[] => {
  const names = new Set<string>([managed.import_name]);
  if (!managed.no_mangle) {
    if (managed.char_set === "unicode") names.add(`${managed.import_name}W`);
    if (managed.char_set === "ansi") names.add(`${managed.import_name}A`);
    if (managed.call_convention === "stdcall") {
      names.add(`_${managed.import_name}`);
      names.add(`_${managed.import_name}@0`);
    }
  }
  return [...names];
};

const sameSymbolName = (left: string, right: string): boolean =>
  normalizeSymbol(left) === normalizeSymbol(right);

const normalizeSymbol = (value: string): string =>
  value.replace(/^_+/u, "").replace(/@\d+$/u, "").toLowerCase();

const moduleCompatible = (
  scope: string | null,
  symbol: NativeSymbol,
): boolean => {
  if (scope === null) return true;
  const expected = normalizeModule(scope);
  return [symbol.module_name, symbol.module_path]
    .filter((value): value is string => value !== null)
    .map(normalizeModule)
    .some((value) => value === expected);
};

const normalizeModule = (value: string): string =>
  basename(value)
    .toLowerCase()
    .replace(/^lib/u, "")
    .replace(/\.(dll|dylib|so|node|exe)$/u, "");

const moduleName = (
  evidence: ReturnType<typeof parseEvidence>,
): string | null => evidence.subject?.name ?? null;

const modulePath = (
  evidence: ReturnType<typeof parseEvidence>,
): string | null => evidence.subject?.local_path ?? null;

const countStatuses = (
  items: readonly z.infer<typeof pinvokeVerificationSchema>[],
): Pick<
  ManagedNativeVerificationResult["summary"],
  "verified" | "inferred" | "unresolved" | "contradicted"
> => ({
  verified: items.filter(({ status }) => status === "verified").length,
  inferred: items.filter(({ status }) => status === "inferred").length,
  unresolved: items.filter(({ status }) => status === "unresolved").length,
  contradicted: items.filter(({ status }) => status === "contradicted").length,
});
