import {
  completedStableArtifactObservation,
  type StableArtifactSnapshot,
  projectOwnedArtifactIdentityFailure,
  projectSelectedArtifactFileFailure,
  projectStableArtifactFailure,
  stableArtifactInputFailure,
  projectArtifactCloseFailure,
  ArtifactReaderFailure,
  readStableArtifact,
  withStableArtifactHandle,
  artifactFileCompletion,
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  assertArtifactReadActive,
  ArtifactResourceScope,
} from "../../resources/index.js";
import { FieldReader } from "./AppleIpsFieldReader.js";
import {
  type AppleIps,
  MAX_INSPECT_APPLE_IPS_FILE_BYTES,
  MAX_INSPECT_APPLE_IPS_JOIN_BYTES,
  MAX_INSPECT_APPLE_IPS_FRAMES,
  MAX_INSPECT_APPLE_IPS_IMAGES,
  MAX_INSPECT_APPLE_IPS_REGISTERS,
  MAX_INSPECT_APPLE_IPS_INTEGER_TEXT_BYTES,
  DEFAULT_INSPECT_APPLE_IPS_INTEGER_TEXT_BYTES,
  MAX_INSPECT_APPLE_IPS_THREADS,
  type InspectAppleIpsInput,
} from "../../domain/native/appleIps.js";
import type { AppleIpsPort } from "../../ports/binaryDiagnostics/AppleIpsPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import {
  isParseLimit,
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import type { LimitRef } from "../../domain/parseFailure.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { err, ok } from "../../domain/result.js";
import { APPLE_IPS_PROVIDER } from "../../domain/investigationProviders.js";
import {
  APPLE_IPS_FORMAT,
  type AppleIpsFixedBoundary,
  type AppleIpsSelectedBoundary,
} from "./AppleIps.errors.js";
import { parseAppleIps } from "./AppleIpsParser.js";
import { resolveAppleIpsJoin } from "./AppleIpsMachOJoin.js";
import { errorMessage } from "../../kernel/errorMessage.js";

const OPERATION = "inspect_apple_ips";

/** Portable .ips reader over one bounded, identity-checked regular file. */
export class AppleIpsProvider implements AppleIpsPort {
  readonly identity = APPLE_IPS_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        APPLE_IPS_PROVIDER.id,
        OPERATION,
      );
    }
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
      const primary = appleIpsFailurePrimary(
        artifactFilePrimaryFacts(cause),
        {
          ...input,
          path: activePath,
          max_file_bytes:
            activeField === "path"
              ? input.max_file_bytes
              : input.max_join_bytes,
        },
        activeField === "path" ? "path" : "join_path",
      );
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

const fileSizeRemediation = (
  input: InspectAppleIpsInput,
  field: "path" | "join_path",
): string => {
  const argument = field === "path" ? "max_file_bytes" : "max_join_bytes";
  const maximum =
    field === "path"
      ? MAX_INSPECT_APPLE_IPS_FILE_BYTES
      : MAX_INSPECT_APPLE_IPS_JOIN_BYTES;
  const effective = input.max_file_bytes;
  return effective >= maximum
    ? `The selected ${field} artifact exceeds this operation's ${String(maximum)}-byte ceiling; select a smaller artifact.`
    : `Raise ${argument} above ${String(effective)} bytes or select a smaller artifact; this is the caller-selected read budget.`;
};

const SELECTED_BUDGETS = {
  threads: {
    argument: "max_threads",
    maximum: MAX_INSPECT_APPLE_IPS_THREADS,
    unit: "entries",
  },
  frames: {
    argument: "max_frames",
    maximum: MAX_INSPECT_APPLE_IPS_FRAMES,
    unit: "entries",
  },
  images: {
    argument: "max_images",
    maximum: MAX_INSPECT_APPLE_IPS_IMAGES,
    unit: "entries",
  },
  registers: {
    argument: "max_registers",
    maximum: MAX_INSPECT_APPLE_IPS_REGISTERS,
    unit: "entries",
  },
  integer_text: {
    argument: "max_integer_text_bytes",
    maximum: MAX_INSPECT_APPLE_IPS_INTEGER_TEXT_BYTES,
    unit: "UTF-16 bytes",
  },
} as const satisfies Record<
  AppleIpsSelectedBoundary,
  {
    readonly argument: keyof InspectAppleIpsInput;
    readonly maximum: number;
    readonly unit: string;
  }
>;

const isSelectedBoundary = (
  boundary: string,
): boundary is AppleIpsSelectedBoundary =>
  Object.hasOwn(SELECTED_BUDGETS, boundary);

const budgetRemediation = (
  boundary: AppleIpsSelectedBoundary,
  selected: number,
): string => {
  const { argument, maximum, unit } = SELECTED_BUDGETS[boundary];
  const recovery =
    selected >= maximum
      ? `This release has no override above the ${String(maximum)} ${unit} ceiling; select a smaller report.`
      : `Raise ${argument} on the next call, up to ${String(maximum)} ${unit}, or select a smaller report; no restart is required.`;
  const explanation =
    boundary === "integer_text"
      ? ` The default is ${String(DEFAULT_INSPECT_APPLE_IPS_INTEGER_TEXT_BYTES)} UTF-16 bytes. Conservative reservation precedes numeric conversion and address expansion; max_file_bytes and row budgets do not raise it.`
      : "";
  return `Effective ${argument} is ${String(selected)} ${unit}. ${recovery}${explanation}`;
};

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
        remediationAction: budgetRemediation(name, maximum),
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
  facts: ArtifactFilePrimaryFacts,
  input: InspectAppleIpsInput,
  field: "path" | "join_path",
): AnalysisError => {
  const { cause, origin } = facts;
  if (origin === "owned-or-classified" && cause instanceof AnalysisError)
    return cause;
  const identityFailure = projectOwnedArtifactIdentityFailure(
    facts,
    OPERATION,
    input.path,
  );
  if (identityFailure !== undefined) return identityFailure;
  if (isParseLimit(cause, APPLE_IPS_FORMAT))
    return parseLimitConstraint(OPERATION, "capacity", cause, {
      ...resourceRecovery(cause.failure.limit),
      path: input.path,
    });
  const formatFailure = parseFailureAnalysisError(
    OPERATION,
    input.path,
    cause,
    field,
  );
  if (formatFailure !== undefined) return formatFailure;
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        cause.message,
        {
          [field === "path" ? "max_file_bytes" : "max_join_bytes"]:
            input.max_file_bytes,
          selected_input: field,
        },
        {
          cause,
          retryable: false,
          remediationAction: fileSizeRemediation(input, field),
        },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return stableArtifactInputFailure(cause, OPERATION, field);
  }
  const fileFailure = projectSelectedArtifactFileFailure(
    cause,
    OPERATION,
    input.path,
    "report",
    field,
  );
  if (fileFailure !== undefined) return fileFailure;
  return new ProviderAdapterError(APPLE_IPS_PROVIDER.id, OPERATION, {
    cause,
    diagnostics: {
      path: input.path,
      reason: errorMessage(cause),
    },
  });
};
