import {
  completedStableArtifactObservation,
  type StableArtifactSnapshot,
  projectStableArtifactFailure,
  closeArtifactResources,
  readStableArtifact,
  withStableArtifactHandle,
  artifactFileCompletion,
  artifactFilePrimaryFacts,
  assertArtifactReadActive,
  ArtifactResourceScope,
} from "../../resources/index.js";
import { FieldReader } from "./AppleIpsFieldReader.js";
import {
  type AppleIps,
  appleIpsBudgetLimit,
  type AppleIpsBudget,
  type InspectAppleIpsInput,
} from "../../domain/native/appleIps.js";
import type { AppleIpsPort } from "../../ports/binaryDiagnostics/AppleIpsPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import {
  isParseLimit,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";
import type { LimitRef } from "../../domain/parseFailure.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import { err, ok } from "../../domain/result.js";
import { APPLE_IPS_PROVIDER } from "../../domain/investigationProviders.js";
import {
  APPLE_IPS_FORMAT,
  type AppleIpsFixedBoundary,
  type AppleIpsSelectedBoundary,
} from "./AppleIps.errors.js";
import { parseAppleIps } from "./AppleIpsParser.js";
import { resolveAppleIpsJoin } from "./AppleIpsMachOJoin.js";

const OPERATION = "inspect_apple_ips";

/** Portable .ips reader over one bounded, identity-checked regular file. */
export class AppleIpsProvider implements AppleIpsPort {
  readonly identity = APPLE_IPS_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      APPLE_IPS_PROVIDER,
      OPERATION,
    );
  }

  async inspect(input: InspectAppleIpsInput, options?: ExecutionOptions) {
    let completedReport: AppleIps | undefined;
    let candidateJoin: AppleIps | undefined;
    let activePath = input.path;
    let activeField: "path" | "join_path" = "path";
    let completedSnapshot:
      | StableArtifactSnapshot
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    const read = new FieldReader(input.max_integer_text_bytes);
    try {
      return await this.#resources.run(async () => {
        const snapshot = await readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        completedSnapshot = snapshot;
        assertArtifactReadActive(options?.signal);
        const report = parseAppleIps(
          snapshot.bytes,
          {
            path: input.path,
            sha256: snapshot.sha256,
            bytes: snapshot.bytes.length,
          },
          input,
          read,
        );
        completedReport = report;
        assertArtifactReadActive(options?.signal);
        if (input.join_path === undefined) return ok(report);
        const joinPath = input.join_path;
        activePath = joinPath;
        activeField = "join_path";
        completedSnapshot = undefined;
        completedReport = await withStableArtifactHandle(
          joinPath,
          input.max_join_bytes,
          {
            retainBytes: (size) => Math.min(size, 4096),
            signal: options?.signal,
            resourceScope: this.#resources,
            onIdentity: (identity) => {
              completedSnapshot = identity;
            },
          },
          async (joinHandle) => {
            assertArtifactReadActive(options?.signal);
            const readJoinRange: typeof joinHandle.readRange = (
              offset,
              length,
            ) =>
              offset >= 0 &&
              length >= 0 &&
              offset + length <= joinHandle.prefix.length
                ? Promise.resolve(
                    joinHandle.prefix.subarray(offset, offset + length),
                  )
                : joinHandle.readRange(offset, length);
            candidateJoin = {
              ...report,
              join: await resolveAppleIpsJoin(
                report,
                {
                  path: joinPath,
                  sha256: joinHandle.sha256,
                  size: joinHandle.size,
                  readRange: readJoinRange,
                },
                {
                  path: joinPath,
                  max_join_bytes: input.max_join_bytes,
                },
                read,
              ),
            };
            return candidateJoin;
          },
        );
        assertArtifactReadActive(options?.signal);
        return ok(completedReport);
      });
    } catch (cause) {
      if (
        candidateJoin !== undefined &&
        artifactFileCompletion(cause)?.value === candidateJoin
      )
        completedReport = candidateJoin;
      const facts = artifactFilePrimaryFacts(cause);
      const activeInput = {
        ...input,
        path: activePath,
        max_file_bytes:
          activeField === "path" ? input.max_file_bytes : input.max_join_bytes,
      };
      const primary = appleIpsFailurePrimary(facts, activeInput, activeField);
      if (completedReport !== undefined) {
        const joinArtifact = completedStableArtifactObservation(
          cause,
          activePath,
          completedSnapshot,
        );
        primary.retainPartialObservation(
          input.join_path !== undefined &&
            activePath === input.join_path &&
            joinArtifact !== undefined
            ? { ...completedReport, join_artifact: joinArtifact }
            : completedReport,
        );
      }
      const failure = projectStableArtifactFailure(
        cause,
        primary,
        activePath,
        APPLE_IPS_PROVIDER.id,
        OPERATION,
        completedSnapshot,
      );
      return err(failure);
    }
  }
}

/** The schema field of each boundary the parser names. */
const SELECTED_BUDGETS = {
  threads: "max_threads",
  frames: "max_frames",
  images: "max_images",
  registers: "max_registers",
  integer_text: "max_integer_text_bytes",
} as const satisfies Record<AppleIpsSelectedBoundary, AppleIpsBudget>;

const isSelectedBoundary = (
  boundary: string,
): boundary is AppleIpsSelectedBoundary =>
  Object.hasOwn(SELECTED_BUDGETS, boundary);

/** The unit each fixed IPS format ceiling counts. */
const FIXED_BOUNDARY_UNITS: Readonly<Record<AppleIpsFixedBoundary, string>> = {
  termination_reasons: "termination reasons",
  unlisted_keys: "keys",
  nesting: "levels",
};

const isFixedBoundary = (name: string): name is AppleIpsFixedBoundary =>
  Object.hasOwn(FIXED_BOUNDARY_UNITS, name);

const resourceRecovery = ({ name, maximum }: LimitRef) =>
  isSelectedBoundary(name)
    ? {
        retryable: false,
        limit: appleIpsBudgetLimit(SELECTED_BUDGETS[name], maximum),
      }
    : fixedAllowanceOptions(
        `The IPS ${name.replaceAll("_", " ")} allowance`,
        "parser",
        {
          limit: maximum,
          ...(isFixedBoundary(name)
            ? { unit: FIXED_BOUNDARY_UNITS[name] }
            : {}),
        },
      );

const appleIpsFailurePrimary = (
  facts: ReturnType<typeof artifactFilePrimaryFacts>,
  input: InspectAppleIpsInput,
  field: "path" | "join_path",
): AnalysisError =>
  classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: APPLE_IPS_PROVIDER.id,
      operation: OPERATION,
      path: input.path,
      description: "report",
      field,
      recognise: (failure) =>
        isParseLimit(failure, APPLE_IPS_FORMAT)
          ? parseLimitConstraint(OPERATION, "capacity", failure, {
              ...resourceRecovery(failure.failure.limit),
              path: input.path,
            })
          : undefined,
      fileSize: (failure) =>
        new AnalysisResourceConstraintError(
          OPERATION,
          "file-size",
          failure.message,
          {
            [field === "path" ? "max_file_bytes" : "max_join_bytes"]:
              input.max_file_bytes,
            selected_input: field,
          },
          {
            cause: failure,
            retryable: false,
            limit: appleIpsBudgetLimit(
              field === "path" ? "max_file_bytes" : "max_join_bytes",
              input.max_file_bytes,
            ),
          },
        ),
    }),
  );
