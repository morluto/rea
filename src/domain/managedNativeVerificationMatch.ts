import { createHash } from "node:crypto";
import { basename } from "node:path";

import canonicalize from "canonicalize";

import { parseEvidence } from "./evidence.js";
import { functionDossierSchema } from "./hopperValues.js";
import { inspectMachoSchema } from "./nativeInspection.js";
import type { ManagedNativeBoundaryInspection } from "./managedArtifact.js";
import type { JsonValue } from "./jsonValue.js";
import {
  pinvokeVerificationSchema,
  type ManagedNativeVerificationInput,
  type ManagedNativeVerificationResult,
  type NativeSymbol,
  type PinvokeVerification,
} from "./managedNativeVerificationSchemas.js";

const digest = (value: JsonValue): string => {
  const serialized = canonicalize(value);
  if (serialized === undefined)
    throw new TypeError("Managed/native verification canonicalization failed");
  return createHash("sha256").update(serialized).digest("hex");
};

type PinvokeImport =
  ManagedNativeBoundaryInspection["pinvoke_imports"]["items"][number];
type VerifiedPinvoke = {
  readonly verification: PinvokeVerification;
  readonly omittedCandidates: number;
};

const moduleName = (
  evidence: ReturnType<typeof parseEvidence>,
): string | null => evidence.subject?.name ?? null;

const modulePath = (
  evidence: ReturnType<typeof parseEvidence>,
): string | null => evidence.subject?.local_path ?? null;

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

export const collectNativeSymbols = (
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

const normalizeSymbol = (value: string): string =>
  value.replace(/^_+/u, "").replace(/@\d+$/u, "").toLowerCase();

const sameSymbolName = (left: string, right: string): boolean =>
  normalizeSymbol(left) === normalizeSymbol(right);

const normalizeModule = (value: string): string =>
  basename(value)
    .toLowerCase()
    .replace(/^lib/u, "")
    .replace(/\.(dll|dylib|so|node|exe)$/u, "");

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

interface CandidateSelection {
  readonly allCandidates: readonly NativeSymbol[];
  readonly candidates: readonly NativeSymbol[];
  readonly selected: NativeSymbol | null;
  readonly exact: NativeSymbol | undefined;
  readonly decorated: NativeSymbol | undefined;
}

const selectCandidates = (
  managed: PinvokeImport,
  symbols: readonly NativeSymbol[],
  maxCandidates: number,
): CandidateSelection => {
  const names = candidateNames(managed);
  const allCandidates = symbols.filter((symbol) =>
    names.some((name) => sameSymbolName(name, symbol.name)),
  );
  const candidates = allCandidates.slice(0, maxCandidates);
  const exact = candidates.find(
    (symbol) =>
      sameSymbolName(managed.import_name, symbol.name) &&
      moduleCompatible(managed.import_scope_name, symbol),
  );
  const decorated = candidates.find((symbol) =>
    moduleCompatible(managed.import_scope_name, symbol),
  );
  const selected = exact ?? decorated ?? candidates[0] ?? null;
  return { allCandidates, candidates, selected, exact, decorated };
};

interface BasisAndStatus {
  readonly basis: PinvokeVerification["basis"];
  readonly status: PinvokeVerification["status"];
  readonly confidence: PinvokeVerification["confidence"];
}

const basisAndStatus = (
  managed: PinvokeImport,
  selection: CandidateSelection,
  hasSupportedNativeEvidence: boolean,
): BasisAndStatus => {
  const { selected, exact } = selection;
  if (selected === null)
    return {
      basis: hasSupportedNativeEvidence
        ? "no-native-candidate"
        : "unsupported-native-evidence",
      status: "unresolved",
      confidence: "unknown",
    };
  if (!moduleCompatible(managed.import_scope_name, selected))
    return {
      basis: "module-mismatch",
      status: "contradicted",
      confidence: "unknown",
    };
  if (exact !== undefined)
    return {
      basis:
        selected.source === "macho-export"
          ? "exact-export-name"
          : "exact-function-name",
      status: "verified",
      confidence: "observed",
    };
  return {
    basis: "decorated-name-candidate",
    status: "inferred",
    confidence: "inferred",
  };
};

const pinvokeLimitations = (
  status: PinvokeVerification["status"],
  managed: PinvokeImport,
): readonly string[] => [
  ...(managed.import_scope_name === null
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

interface VerifyPinvokeContext {
  readonly item: PinvokeImport;
  readonly managedEvidenceId: string;
  readonly symbols: readonly NativeSymbol[];
  readonly hasSupportedNativeEvidence: boolean;
  readonly input: ManagedNativeVerificationInput;
}

export const verifyPinvoke = ({
  item,
  managedEvidenceId,
  symbols,
  hasSupportedNativeEvidence,
  input,
}: VerifyPinvokeContext): VerifiedPinvoke => {
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
  const selection = selectCandidates(
    item,
    symbols,
    input.limits.max_candidates_per_import,
  );
  const { status, basis, confidence } = basisAndStatus(
    item,
    selection,
    hasSupportedNativeEvidence,
  );
  const limitations = pinvokeLimitations(status, item);
  return {
    verification: pinvokeVerificationSchema.parse({
      item_id: `mnv_pinvoke_${digest({
        managedEvidenceId,
        token: item.token,
        importName: item.import_name,
        importScope: item.import_scope_name,
        candidates: [...selection.candidates],
      })}`,
      managed,
      status,
      basis,
      confidence,
      matched_native: selection.selected,
      candidates: selection.candidates,
      evidence_links: [
        managedEvidenceId,
        ...new Set(selection.candidates.map(({ evidence_id: id }) => id)),
      ],
      limitations,
    }),
    omittedCandidates: Math.max(
      0,
      selection.allCandidates.length - selection.candidates.length,
    ),
  };
};

const countStatuses = (
  items: readonly PinvokeVerification[],
): Pick<
  ManagedNativeVerificationResult["summary"],
  "verified" | "inferred" | "unresolved" | "contradicted"
> => ({
  verified: items.filter(({ status }) => status === "verified").length,
  inferred: items.filter(({ status }) => status === "inferred").length,
  unresolved: items.filter(({ status }) => status === "unresolved").length,
  contradicted: items.filter(({ status }) => status === "contradicted").length,
});

interface VerificationResultInput {
  readonly managedEvidence: ReturnType<typeof parseEvidence>;
  readonly managed: ManagedNativeBoundaryInspection;
  readonly native: {
    readonly symbols: readonly NativeSymbol[];
    readonly accepted: number;
    readonly unsupported: number;
  };
  readonly pinvokeImports: readonly PinvokeVerification[];
  readonly verifiedPinvokes: readonly VerifiedPinvoke[];
  readonly input: ManagedNativeVerificationInput;
}

export const buildVerificationResult = ({
  managedEvidence,
  managed,
  native,
  pinvokeImports,
  verifiedPinvokes,
  input,
}: VerificationResultInput): Omit<
  ManagedNativeVerificationResult,
  "verification_id"
> => {
  const counts = countStatuses(pinvokeImports);
  const omittedNativeObservations = Math.max(
    0,
    input.native_observations.length - input.limits.max_native_observations,
  );
  const omittedCandidates = verifiedPinvokes.reduce(
    (sum, item) => sum + item.omittedCandidates,
    0,
  );
  const nativeBodyUnresolved = managed.native_implementations.items.filter(
    ({ boundary_kind: kind }) => kind !== "pinvoke",
  ).length;
  const coverageStatus =
    omittedNativeObservations > 0 || omittedCandidates > 0
      ? "truncated"
      : managed.coverage.state === "complete" && native.unsupported === 0
        ? "complete-within-inputs"
        : "partial";
  return {
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
      native_body_unresolved: nativeBodyUnresolved,
    },
    pinvoke_imports: [...pinvokeImports],
    native_implementations: {
      unresolved: nativeBodyUnresolved,
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
};
