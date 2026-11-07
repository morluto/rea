import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { CapabilityDescriptor } from "../AnalysisProvider.js";
import {
  toolProviderRequirements,
  type ToolProviderRequirements,
} from "../CapabilityInventory.js";
import type { AnalysisProviderCandidateStatus } from "./AnalysisProviderRegistry.js";

type Requirements = readonly (string | readonly string[])[];

/** One provider's static declaration of one required operation. */
export type OperationDeclaration =
  | { readonly operation: string; readonly status: "available" }
  | {
      readonly operation: string;
      readonly status: "unavailable";
      readonly reason: string;
      readonly availability_code: string | null;
    }
  | { readonly operation: string; readonly status: "not_declared" };

type DeclarationStatus = OperationDeclaration["status"];

/**
 * Resolve a tool's provider requirements for the operation view. Only tools
 * whose every required operation belongs to a deep provider are in scope:
 * other operations are served by auxiliary owners that are not candidates, so
 * reporting them as undeclared would be wrong.
 */
export const resolveOperationRequirements = (
  operation: string,
  deepOperations: ReadonlySet<string>,
): Result<ToolProviderRequirements, AnalysisInputError> => {
  const requirements = toolProviderRequirements(operation);
  if (requirements === undefined)
    return err(
      operationViewRefusal(
        `Unknown tool ${operation}. Pass a tool name from tools/list, such as search_bytes.`,
      ),
    );
  const outside = requiredOperations(requirements).filter(
    (required) => !deepOperations.has(required),
  );
  if (outside.length > 0)
    return err(
      operationViewRefusal(
        `${operation} depends on operations no deep provider declares (${outside.join(", ")}), so the operation view does not cover it. Use detail: "complete".`,
      ),
    );
  return ok(requirements);
};

const operationViewRefusal = (message: string) =>
  new AnalysisInputError("binary_session", {
    userMessage: message,
    remediationAction:
      'Pass a deep-provider tool as operation, or use detail: "complete" for every candidate capability.',
    conformsToInputContract: true,
  });

/**
 * Project each candidate's readiness, target support, selection and
 * declaration of the requested tool's operations as separate facts. Nothing
 * here combines them into one suitability verdict, and an unknown state
 * stays unknown.
 */
export const operationCandidates = (
  candidates: readonly AnalysisProviderCandidateStatus[],
  requirements: ToolProviderRequirements,
) =>
  candidates.map((candidate) => ({
    provider: {
      id: candidate.provider.id,
      name: candidate.provider.name,
      version: candidate.provider.version,
    },
    selected: candidate.selected,
    availability: providerStateSummary(candidate.availability),
    target_support: providerStateSummary(candidate.targetSupport),
    declaration: candidateDeclaration(candidate.capabilities, requirements),
  }));

/** Caller-visible requirement shape, so missing operations can be read in context. */
export const operationRequirementsView = (
  requirements: ToolProviderRequirements,
) =>
  requirements.kind === "operations"
    ? {
        kind: "operations" as const,
        requirements: requirementsView(requirements.requirements),
      }
    : {
        kind: "modes" as const,
        default_mode: requirements.defaultMode,
        modes: requirements.modes.map((mode) => ({
          name: mode.name,
          requirements: requirementsView(mode.requirements),
        })),
      };

const requirementsView = (requirements: Requirements) =>
  requirements.map((requirement) =>
    typeof requirement === "string" ? requirement : [...requirement],
  );

const candidateDeclaration = (
  capabilities: readonly CapabilityDescriptor[],
  requirements: ToolProviderRequirements,
) => {
  const descriptors = new Map<string, CapabilityDescriptor>(
    capabilities.map((descriptor) => [descriptor.operation, descriptor]),
  );
  const operations = requiredOperations(requirements).map((operation) =>
    declarationOf(operation, descriptors.get(operation)),
  );
  const byOperation = new Map(
    operations.map((declaration) => [declaration.operation, declaration]),
  );
  if (requirements.kind === "operations") {
    const evaluated = evaluate(requirements.requirements, byOperation);
    return { ...evaluated, operations };
  }
  const modes = requirements.modes.map((mode) => ({
    name: mode.name,
    ...evaluate(mode.requirements, byOperation),
  }));
  const status: DeclarationStatus = modes.some(
    (mode) => mode.status === "available",
  )
    ? "available"
    : operations.every(({ status }) => status === "not_declared")
      ? "not_declared"
      : "unavailable";
  return {
    status,
    missing_operations: [
      ...new Set(modes.flatMap((mode) => mode.missing_operations)),
    ],
    operations,
    ...(requirements.defaultMode === null
      ? {}
      : {
          default_mode_available:
            modes.find((mode) => mode.name === requirements.defaultMode)
              ?.status === "available",
        }),
    modes,
  };
};

/** A group is met when any one of its operations is declared available. */
const evaluate = (
  requirements: Requirements,
  declarations: ReadonlyMap<string, OperationDeclaration>,
): {
  readonly status: DeclarationStatus;
  readonly missing_operations: string[];
} => {
  const groups = requirements.map((requirement) =>
    typeof requirement === "string" ? [requirement] : [...requirement],
  );
  const unmet = groups.filter(
    (group) =>
      !group.some(
        (operation) => declarations.get(operation)?.status === "available",
      ),
  );
  const missing = [...new Set(unmet.flat())];
  if (unmet.length === 0)
    return { status: "available", missing_operations: [] };
  const declared = groups
    .flat()
    .some(
      (operation) =>
        (declarations.get(operation)?.status ?? "not_declared") !==
        "not_declared",
    );
  return {
    status: declared ? "unavailable" : "not_declared",
    missing_operations: missing,
  };
};

const declarationOf = (
  operation: string,
  descriptor: CapabilityDescriptor | undefined,
): OperationDeclaration =>
  descriptor === undefined
    ? { operation, status: "not_declared" }
    : descriptor.available
      ? { operation, status: "available" }
      : {
          operation,
          status: "unavailable",
          reason: descriptor.reason,
          availability_code: descriptor.availabilityCode ?? null,
        };

const requiredOperations = (requirements: ToolProviderRequirements) => {
  const groups =
    requirements.kind === "operations"
      ? requirements.requirements
      : requirements.modes.flatMap((mode) => mode.requirements);
  return [
    ...new Set(
      groups.flatMap((group) => (typeof group === "string" ? [group] : group)),
    ),
  ];
};

/**
 * Keep a provider-owned status, code and reason; diagnostics stay in complete
 * detail. Summary candidates and the operation view share this projection.
 */
export const providerStateSummary = <
  State extends {
    readonly status: string;
    readonly code: string | null;
    readonly reason: string | null;
  },
>({
  status,
  code,
  reason,
}: State) => ({ status, code, reason });
