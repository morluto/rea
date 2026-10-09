import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import {
  NATIVE_MACOS_PROVIDER_IDENTITY as IDENTITY,
  nativeMacOSCapabilities,
} from "./NativeMacOSProviderMetadata.js";
import { inspectAppleDispatchMetadata } from "./AppleDispatchMetadata.js";
import { observeNativeUi } from "./NativeUiObservation.js";
import { LldbCallTracer, type NativeCallTracer } from "./LldbCallTracer.js";
import { observeNativeCalls } from "./NativeCallObservation.js";
import { dirname, isAbsolute, resolve } from "node:path";
import { open, realpath, stat } from "node:fs/promises";

import { z } from "zod";

import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperation,
  type AnalysisProvider,
  type CapabilityDescriptor,
  type ProviderIdentity,
} from "../application/AnalysisProvider.js";
import {
  NATIVE_TOOL_CONTRACTS,
  type NativeToolName,
} from "../contracts/native/nativeToolContracts.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { toolContract } from "../contracts/toolContracts.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import type { EvidenceLocation } from "../domain/evidence.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { BinaryTargetError } from "../domain/configurationErrors.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import {
  omittedPrototypeKeysLimitation,
  parseXmlPropertyList,
} from "../domain/propertyListKeys.js";
import {
  demangleSwiftSchema,
  inspectPlistSchema,
  inspectSignatureSchema,
  listArchitecturesSchema,
  type NativeCommandInvocation,
} from "../domain/native/nativeInspection.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  NATIVE_COMMAND_TIMEOUT_MS,
  NATIVE_COMMAND_OUTPUT_BUDGET_BYTES,
  NativeCommandFailure,
  XcrunCommandRunner,
  type NativeCommandCapture,
  type NativeCommandRunner,
} from "./CommandRunner.js";
import {
  withSignatureTarget,
  verifySignatureTarget,
  type SignatureTargetBinding,
} from "./SignatureTargetBinding.js";
import { parseCodeSignature } from "./parsers/codesign.js";
import { parseDemangledSymbols } from "./parsers/demangle.js";
import { parseLipoArchitectures } from "./parsers/lipo.js";
import {
  parsePlistJson,
  parsePlistXml,
  plistJsonNeedsNumberTypes,
} from "./parsers/plist.js";
import {
  architectureLocations,
  inspectNativeMacho,
} from "./NativeMachoInspection.js";

/** Read-only semantic provider composed from Xcode command-line utilities. */
export class NativeMacOSProvider implements AnalysisProvider {
  readonly #capabilities: readonly CapabilityDescriptor[];
  readonly #environment: NodeJS.ProcessEnv;

  constructor(
    environment: Readonly<NodeJS.ProcessEnv>,
    private readonly runner: NativeCommandRunner = new XcrunCommandRunner(
      environment,
    ),
    platform: NodeJS.Platform = process.platform,
    private readonly tracer: NativeCallTracer = new LldbCallTracer(environment),
  ) {
    this.#environment = snapshotEnvironment(environment, platform);
    this.#capabilities = nativeMacOSCapabilities(platform);
  }

  identity(): ProviderIdentity {
    return IDENTITY;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return this.#capabilities;
  }

  createClient(target: BinaryTarget): AnalysisClient {
    return new NativeMacOSClient(
      target,
      this.runner,
      this.tracer,
      this.#environment,
    );
  }
}

class NativeMacOSClient implements AnalysisClient {
  constructor(
    private readonly target: BinaryTarget,
    private readonly runner: NativeCommandRunner,
    private readonly tracer: NativeCallTracer,
    private readonly environment: Readonly<NodeJS.ProcessEnv>,
  ) {}

  async execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: { readonly signal?: AbortSignal },
  ) {
    if (options?.signal?.aborted === true)
      return err(new AnalysisCancelledError(operation));
    if (operation === "health")
      return ok(createAnalysisExecution(null, IDENTITY));
    if (operation === "inspect_native_dispatch_metadata") {
      const input = toolContract(operation).inputSchema.safeParse(parameters);
      if (!input.success)
        return err(
          analysisInputErrorFromIssues(
            operation,
            input.error.issues,
            parameters,
            {
              cause: input.error,
            },
          ),
        );
      if (this.target.kind !== "executable" || this.target.format !== "mach-o")
        return err(
          new AnalysisCapabilityUnavailableError(
            IDENTITY.id,
            operation,
            "Binary Apple metadata requires Mach-O; other providers can report symbol-only metadata",
          ),
        );
      try {
        const result = await inspectAppleDispatchMetadata(
          this.target,
          input.data.max_records,
          options?.signal,
        );
        return ok(
          createAnalysisExecution(result, result.provider, {
            locations: [{ kind: "artifact-path", path: this.target.path }],
            limitations: result.result.coverage.flatMap(({ reason }) =>
              reason === null ? [] : [reason],
            ),
          }),
        );
      } catch (cause) {
        if (cause instanceof AnalysisError) return err(cause);
        return err(
          options?.signal?.aborted
            ? new AnalysisCancelledError(operation)
            : new ProviderAdapterError(IDENTITY.id, operation, {
                cause,
                diagnostics: {
                  target_path: this.target.path,
                  reason:
                    cause instanceof Error ? cause.message : String(cause),
                },
              }),
        );
      }
    }
    if (!isNativeOperation(operation))
      return err(
        new AnalysisCapabilityUnavailableError(
          IDENTITY.id,
          operation,
          "Operation is not implemented by native macOS tools.",
        ),
      );
    if (operation === "observe_native_calls") {
      const result = await observeNativeCalls(
        this.target,
        parameters,
        this.tracer,
        options?.signal,
      );
      return result.ok
        ? ok(
            createAnalysisExecution(result.value, IDENTITY, {
              limitations: result.value.limitations,
              locations: [{ kind: "artifact-path", path: this.target.path }],
            }),
          )
        : result;
    }
    if (
      operation === "observe_native_ui" ||
      operation === "capture_native_ui_scenario"
    ) {
      const result = await observeNativeUi(this.target, operation, parameters, {
        environment: this.environment,
        signal: options?.signal,
      });
      return result.ok
        ? ok(
            createAnalysisExecution(result.value, IDENTITY, {
              limitations: result.value.limitations,
            }),
          )
        : result;
    }
    try {
      const observation = await this.#dispatch(
        operation,
        parameters,
        options?.signal,
      );
      return observation.ok
        ? ok(
            createAnalysisExecution(observation.value.result, IDENTITY, {
              rawResult: { provenance: observation.value.provenance },
              limitations: observation.value.limitations,
              locations: observation.value.locations,
            }),
          )
        : observation;
    } catch (cause: unknown) {
      return err(
        new AnalysisOutputError(operation, "Native output parsing failed", {
          cause,
        }),
      );
    }
  }

  close(): Promise<Result<null, AnalysisError>> {
    return Promise.resolve(ok(null));
  }

  #dispatch(
    operation: NativeToolName,
    parameters: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    switch (operation) {
      case "observe_native_ui":
      case "capture_native_ui_scenario":
      case "observe_native_calls":
        return Promise.resolve(
          err(
            new AnalysisCapabilityUnavailableError(
              IDENTITY.id,
              operation,
              "UI observation uses its explicit authority boundary",
            ),
          ),
        );
      case "inspect_macho":
        return this.#inspectMacho(signal);
      case "inspect_signature":
        return this.#inspectSignature(signal);
      case "inspect_plist":
        return this.#inspectPlist(parameters, signal);
      case "list_architectures":
        return this.#listArchitectures(signal);
      case "demangle_swift":
        return this.#demangle(parameters, signal);
    }
  }

  async #listArchitectures(
    signal?: AbortSignal,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    // lipo reads only Mach-O; its refusal of a PE, ELF, or plist target is not
    // a tool failure that a retry or `rea doctor` could repair.
    if (this.target.format !== "mach-o")
      return err(
        new AnalysisCapabilityUnavailableError(
          IDENTITY.id,
          "list_architectures",
          "Active artifact is not Mach-O.",
        ),
      );
    const capture = await this.#run(
      "list_architectures",
      "lipo",
      ["-detailed_info", this.target.path],
      { signal },
    );
    if (!capture.ok) return capture;
    const provenance = [invocation(capture.value, this.target.path)];
    const architectures = parseLipoArchitectures(capture.value.stdout);
    const result = listArchitecturesSchema.parse({
      architectures: {
        items: architectures,
        total: architectures.length,
        exhaustive: true,
        limitations: [],
      },
      provenance,
      limitations: [],
    });
    return ok({
      result: jsonValueSchema.parse(result),
      provenance,
      limitations: [],
      locations: architectureLocations(result.architectures.items),
    });
  }

  async #demangle(
    parameters: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    const symbols = z.array(z.string()).safeParse(parameters.symbols);
    if (!symbols.success)
      return err(
        new AnalysisOutputError(
          "demangle_swift",
          "symbols were not parsed strings",
        ),
      );
    const capture = await this.#run(
      "demangle_swift",
      "swift-demangle",
      // `--` keeps symbols that begin with `-` from selecting demangler options.
      ["--compact", "--", ...symbols.data],
      { signal },
    );
    if (!capture.ok) return capture;
    const provenance = [invocation(capture.value, this.target.path)];
    const result = demangleSwiftSchema.parse({
      symbols: parseDemangledSymbols(symbols.data, capture.value.stdout),
      provenance,
      limitations: [],
    });
    return ok({
      result: jsonValueSchema.parse(result),
      provenance,
      limitations: [],
      locations: [],
    });
  }

  async #inspectSignature(
    signal?: AbortSignal,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    return withSignatureTarget(
      this.target,
      (binding) => this.#inspectBoundSignature(binding, signal),
      signal,
    );
  }

  async #inspectBoundSignature(
    binding: SignatureTargetBinding,
    signal?: AbortSignal,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    const display = await this.#captureSignature(
      binding,
      ["-d", "--verbose=4"],
      signal,
    );
    if (!display.ok) return display;
    const unsigned = isNonzeroUnsignedObservation(display.value);
    const displayFailure = codeSignCaptureFailure(display.value);
    if (displayFailure !== null) return err(displayFailure);
    const requirements = await this.#captureSignature(
      binding,
      ["-d", "-r-"],
      signal,
    );
    if (!requirements.ok) return requirements;
    const requirementsFailure = codeSignCaptureFailure(requirements.value);
    if (requirementsFailure !== null) return err(requirementsFailure);
    const entitlements = await this.#captureSignature(
      binding,
      ["-d", "--entitlements", ":-"],
      signal,
    );
    if (!entitlements.ok) return entitlements;
    const entitlementsFailure = codeSignCaptureFailure(entitlements.value);
    if (entitlementsFailure !== null) return err(entitlementsFailure);
    // codesign echoes the resolved executable path in its diagnostics.
    const parsed = parseCodeSignature(display.value.stderr, unsigned, [
      binding.snapshotPath,
      ...(await canonicalPath(binding.snapshotPath)),
    ]);
    // The requirement is printed to stdout; stderr echoes the path.
    const requirementText =
      /designated\s*=>\s*(.+)$/mu.exec(requirements.value.stdout)?.[1] ?? null;
    // Entitlements XML is printed to stdout; stderr echoes the path.
    const entitlementValue = parseEntitlements(entitlements.value.stdout);
    const captures = [display.value, requirements.value, entitlements.value];
    const limitations = [
      ...parsed.limitations,
      "Inspected a digest-verified Mach-O byte snapshot; filesystem-bound signing context and trust validation are not examined.",
      ...(entitlementValue.omittedPrototypeKeys === 0
        ? []
        : [
            `Entitlements: ${omittedPrototypeKeysLimitation(entitlementValue.omittedPrototypeKeys)}`,
          ]),
    ];
    const mixedSigning =
      !unsigned &&
      (isNonzeroUnsignedObservation(requirements.value) ||
        isNonzeroUnsignedObservation(entitlements.value));
    if (mixedSigning) {
      const slices = await this.#inspectMixedSignatureSlices(
        binding,
        parsed.format,
        {
          requirements: requirements.value.exitCode,
          entitlements: entitlements.value.exitCode,
        },
        signal,
      );
      if (!slices.ok) return slices;
      captures.push(...slices.value.captures);
      limitations.push(...slices.value.limitations);
    }
    const provenance = captures.map((capture) =>
      invocation(capture, binding.snapshotPath),
    );
    const version = await verifySignatureTarget(this.target, binding, signal);
    if (!version.ok) return version;
    const result = inspectSignatureSchema.parse({
      ...parsed,
      designated_requirement: requirementText,
      entitlements: entitlementValue.value,
      provenance,
      limitations,
    });
    return ok({
      result: jsonValueSchema.parse(result),
      provenance,
      limitations: result.limitations,
      locations: [],
    });
  }

  async #inspectMixedSignatureSlices(
    binding: SignatureTargetBinding,
    format: string | null,
    aggregateExits: Readonly<{
      requirements: number | null;
      entitlements: number | null;
    }>,
    signal?: AbortSignal,
  ): Promise<Result<MixedSignatureSlices, AnalysisError>> {
    const captures: NativeCommandCapture[] = [];
    const unsigned: string[] = [];
    const unclassified: string[] = [];
    for (const architecture of codeSignArchitectures(format, this.target)) {
      const slice = await this.#captureSignature(
        binding,
        ["-d", "-a", architecture, "--verbose=4"],
        signal,
      );
      if (!slice.ok) return slice;
      captures.push(slice.value);
      if (slice.value.exitCode === 0) continue;
      if (isNonzeroUnsignedObservation(slice.value))
        unsigned.push(architecture);
      else unclassified.push(architecture);
    }
    const limitations = [
      unsigned.length > 0
        ? `Unsigned Mach-O slices: ${unsigned.join(", ")}.`
        : "One or more Mach-O slices are unsigned, but their architectures could not be classified.",
    ];
    if (unclassified.length > 0)
      limitations.push(
        `Signature state could not be classified for Mach-O slices: ${unclassified.join(", ")}.`,
      );
    if (aggregateExits.requirements !== 0)
      limitations.push(
        "The aggregate designated requirement is unavailable because Mach-O slices have mixed signing states.",
      );
    if (aggregateExits.entitlements !== 0)
      limitations.push(
        "The aggregate entitlements are unavailable because Mach-O slices have mixed signing states.",
      );
    return ok({ captures, limitations });
  }

  async #captureSignature(
    binding: SignatureTargetBinding,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<Result<NativeCommandCapture, AnalysisError>> {
    const before = await verifySignatureTarget(this.target, binding, signal);
    if (!before.ok) return before;
    let capture: Result<NativeCommandCapture, AnalysisError>;
    try {
      capture = await this.#run(
        "inspect_signature",
        "codesign",
        [...args, binding.snapshotPath],
        {
          signal,
          acceptNonZero: true,
        },
      );
    } catch (cause: unknown) {
      capture = err(
        new ProviderAdapterError(IDENTITY.id, "inspect_signature", {
          cause,
          diagnostics: {
            phase: "codesign-capture",
            path: this.target.path,
            reason: cause instanceof Error ? cause.message : String(cause),
          },
        }),
      );
    }
    // Verify failed captures too: a disappearing target is not a codesign
    // execution failure, and later captures must never use another version.
    const after = await verifySignatureTarget(this.target, binding, signal);
    return after.ok ? capture : after;
  }

  async #inspectPlist(
    parameters: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    const requested = parameters.path;
    if (requested !== undefined && typeof requested !== "string")
      return err(
        new AnalysisOutputError("inspect_plist", "path was not a string"),
      );
    const plist = await resolvePlistPath(this.target, requested);
    if (!plist.ok) return plist;
    const selected = await requireRegularPlist(plist.value, requested);
    if (!selected.ok) return selected;
    const classified = await this.#run(
      "inspect_plist",
      "file",
      ["-b", plist.value],
      { signal },
    );
    if (!classified.ok) return classified;
    const json = await this.#run(
      "inspect_plist",
      "plutil",
      ["-convert", "json", "-o", "-", "--", plist.value],
      { signal, acceptNonZero: true },
    );
    if (!json.ok) return json;
    // JSON cannot express data, dates, or non-finite reals; plutil rejects
    // such plists, so decode its lossless XML conversion instead. JSON also
    // prints an integral <real> like an <integer>, so a number beyond the
    // exact JSON range takes its element type from the XML conversion.
    const jsonDecoded = json.value.exitCode === 0;
    const xml =
      jsonDecoded && !plistJsonNeedsNumberTypes(json.value.stdout)
        ? undefined
        : await this.#run(
            "inspect_plist",
            "plutil",
            ["-convert", "xml1", "-o", "-", "--", plist.value],
            { signal, acceptNonZero: !jsonDecoded },
          );
    if (xml !== undefined && !xml.ok) return xml;
    if (xml !== undefined && xml.value.exitCode !== 0)
      return err(
        unreadablePlist(
          plist.value,
          requested,
          `plutil could not decode it as a property list (${plutilDiagnostic(xml.value.stderr, plist.value)})`,
        ),
      );
    const parsed =
      xml === undefined
        ? parsePlistJson(json.value.stdout)
        : jsonDecoded
          ? parsePlistJson(json.value.stdout, xml.value.stdout)
          : parsePlistXml(xml.value.stdout);
    if (!parsed.ok) return parsed;
    const provenance = [
      classified.value,
      json.value,
      ...(xml === undefined ? [] : [xml.value]),
    ].map((item) => invocation(item, plist.value, "$PLIST"));
    const result = inspectPlistSchema.parse({
      format: /binary property list/iu.test(classified.value.stdout)
        ? "binary"
        : /XML|text/iu.test(classified.value.stdout)
          ? "xml"
          : "unknown",
      value: parsed.value.value,
      bundle: parsed.value.bundle,
      source_path: plist.value,
      provenance,
      limitations: parsed.value.limitations,
    });
    return ok({
      result: jsonValueSchema.parse(result),
      provenance,
      limitations: parsed.value.limitations,
      locations: [{ kind: "artifact-path", path: plist.value }],
    });
  }

  async #inspectMacho(
    signal?: AbortSignal,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    if (this.target.format !== "mach-o")
      return err(
        new AnalysisCapabilityUnavailableError(
          IDENTITY.id,
          "inspect_macho",
          "Active artifact is not Mach-O.",
        ),
      );
    return inspectNativeMacho({
      target: this.target,
      ...(signal === undefined ? {} : { signal }),
      run: (tool, arguments_, commandSignal) =>
        this.#run("inspect_macho", tool, arguments_, {
          signal: commandSignal,
        }),
      invocation: (capture) => invocation(capture, this.target.path),
    });
  }

  async #run(
    operation: NativeToolName,
    tool: string,
    arguments_: readonly string[],
    options: {
      readonly signal?: AbortSignal | undefined;
      readonly acceptNonZero?: boolean;
    } = {},
  ): Promise<Result<NativeCommandCapture, AnalysisError>> {
    const captured = await this.runner.run(tool, arguments_, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      acceptNonZero: options.acceptNonZero ?? false,
    });
    if (captured.ok) return captured;
    return err(translateCommandFailure(operation, captured.error));
  }
}

interface NativeObservation {
  readonly result: JsonValue;
  readonly provenance: readonly NativeCommandInvocation[];
  readonly limitations: readonly string[];
  readonly locations: readonly EvidenceLocation[];
}

interface MixedSignatureSlices {
  readonly captures: readonly NativeCommandCapture[];
  readonly limitations: readonly string[];
}

const isNativeOperation = (
  operation: AnalysisOperation,
): operation is NativeToolName =>
  NATIVE_TOOL_CONTRACTS.some(({ name }) => name === operation);

const translateCommandFailure = (
  operation: NativeToolName,
  failure: NativeCommandFailure,
): AnalysisError => {
  const capturedOutput =
    failure.capture === null
      ? undefined
      : {
          stdout: failure.capture.stdout,
          stderr: failure.capture.stderr,
          truncated: failure.capture.truncated,
          stdout_bytes: failure.capture.stdoutBytes,
          stderr_bytes: failure.capture.stderrBytes,
          exit_code: failure.capture.exitCode,
          signal: failure.capture.signal,
        };
  const cleanup =
    failure.cleanupFailure === null
      ? undefined
      : {
          reason: failure.cleanupFailure,
          resources: [...failure.cleanupResources],
        };
  const errorOptions = {
    ...(capturedOutput === undefined ? {} : { capturedOutput }),
    ...(cleanup === undefined ? {} : { cleanup }),
  };
  if (failure.reason === "unavailable") {
    const reason = `${failure.tool} is unavailable through xcrun.`;
    return new AnalysisCapabilityUnavailableError(
      IDENTITY.id,
      operation,
      reason,
      { ...errorOptions, userMessage: reason },
    );
  }
  if (failure.reason === "cancelled")
    return new AnalysisCancelledError(operation, errorOptions);
  if (failure.reason === "timeout")
    return new AnalysisTimeoutError(
      operation,
      NATIVE_COMMAND_TIMEOUT_MS,
      errorOptions,
    );
  if (failure.reason === "output-limit")
    return new AnalysisResourceConstraintError(
      operation,
      "memory",
      `Native command output exceeded ${String(NATIVE_COMMAND_OUTPUT_BUDGET_BYTES)} bytes; complete output is required for analysis.`,
      { max_output_bytes: NATIVE_COMMAND_OUTPUT_BUDGET_BYTES },
      errorOptions,
    );
  return new ProviderAdapterError(IDENTITY.id, operation, {
    cause: failure,
    ...errorOptions,
    diagnostics: {
      tool: failure.tool,
      reason: failure.reason,
      exit_code: failure.capture?.exitCode ?? failure.exitCode,
      signal: failure.capture?.signal ?? null,
      stdout_bytes: failure.capture?.stdoutBytes ?? 0,
      stderr_bytes: failure.capture?.stderrBytes ?? 0,
    },
  });
};

const translateCodeSignExitFailure = (
  capture: NativeCommandCapture,
): AnalysisError =>
  translateCommandFailure(
    "inspect_signature",
    new NativeCommandFailure(
      "codesign",
      "nonzero-exit",
      capture.exitCode,
      undefined,
      {
        stdout: capture.stdout,
        stderr: capture.stderr,
        stdoutBytes: capture.stdoutBytes,
        stderrBytes: capture.stderrBytes,
        exitCode: capture.exitCode,
        signal: capture.signal,
        truncated: false,
      },
    ),
  );

const commandOutput = (capture: NativeCommandCapture): string =>
  `${capture.stdout}\n${capture.stderr}`;

/**
 * A signed artifact exits zero; its diagnostics can still contain this text
 * through the echoed path or identifier.
 */
const isNonzeroUnsignedObservation = (capture: NativeCommandCapture): boolean =>
  capture.exitCode !== null &&
  capture.exitCode !== 0 &&
  /not signed at all|code object is not signed/iu.test(commandOutput(capture));

const canonicalPath = async (path: string): Promise<string[]> => {
  try {
    return [await realpath(path)];
  } catch {
    return [];
  }
};

const codeSignCaptureFailure = (
  capture: NativeCommandCapture,
): AnalysisError | null =>
  capture.exitCode === 0 || isNonzeroUnsignedObservation(capture)
    ? null
    : translateCodeSignExitFailure(capture);

const codeSignArchitectures = (
  format: string | null,
  target: BinaryTarget,
): string[] => {
  const universal = /^Mach-O universal \(([^)\r\n]+)\)$/u.exec(
    format ?? "",
  )?.[1];
  if (universal !== undefined) {
    const architectures = universal
      .split(/\s+/u)
      .filter((architecture) =>
        /^(?:i386|x86_64|armv7|arm64|arm64e)$/u.test(architecture),
      );
    if (architectures.length > 0) return [...new Set(architectures)];
  }
  if (target.kind !== "executable" || target.format !== "mach-o") return [];
  return target.availableArchitectures.map((architecture) =>
    architecture === "x86" ? "i386" : architecture,
  );
};

const invocation = (
  capture: NativeCommandCapture,
  artifactPath: string,
  alias = "$ARTIFACT",
): NativeCommandInvocation => ({
  tool: capture.tool,
  command: [
    capture.executable,
    ...capture.arguments.map((argument) =>
      argument === artifactPath ? alias : argument,
    ),
  ],
  tool_version: capture.toolVersion,
  version_reason: capture.versionReason,
  executable_sha256: capture.executableSha256,
  exit: { code: capture.exitCode, signal: capture.signal },
  stdout_bytes: capture.stdoutBytes,
  stderr_bytes: capture.stderrBytes,
});

const parseEntitlements = (
  output: string,
): { readonly value: JsonValue; readonly omittedPrototypeKeys: number } => {
  const start = output.indexOf("<?xml");
  const end = output.lastIndexOf("</plist>");
  if (start < 0 || end < start) return { value: null, omittedPrototypeKeys: 0 };
  const { value, omittedPrototypeKeys } = parseXmlPropertyList(
    output.slice(start, end + "</plist>".length),
  );
  return { value: jsonValueSchema.parse(value), omittedPrototypeKeys };
};

/**
 * Report a plist that cannot be decoded as the caller's selection, or as the
 * target's missing default, rather than as a failed tool run.
 */
const unreadablePlist = (
  path: string,
  requested: string | undefined,
  reason: string,
): AnalysisError => {
  const sentence = reason.endsWith(".") ? reason : `${reason}.`;
  // Name the default that is missing and the selection that still works.
  const missingDefault = `The target has no readable Contents/Info.plist at ${path}: ${sentence} Select another plist in the target with the path input (CLI: --relative-path).`;
  return requested === undefined
    ? new AnalysisCapabilityUnavailableError(
        IDENTITY.id,
        "inspect_plist",
        missingDefault,
        { userMessage: missingDefault },
      )
    : new AnalysisInputError("inspect_plist", undefined, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Cannot inspect ${path}: ${sentence}`,
        },
      ]);
};

/** plutil prefixes its diagnostic with the path the message already names. */
const plutilDiagnostic = (stderr: string, path: string): string => {
  const text = stderr.trim();
  return text.startsWith(`${path}: `) ? text.slice(path.length + 2) : text;
};

/**
 * Admit a readable regular file before plutil runs, so a later plutil failure
 * reflects the bytes rather than a missing path or a host permission denial.
 */
const requireRegularPlist = async (
  path: string,
  requested: string | undefined,
): Promise<Result<null, AnalysisError>> => {
  try {
    if (!(await stat(path)).isFile())
      return err(unreadablePlist(path, requested, "it is not a regular file"));
    // Opening also observes ACL and macOS privacy denials that stat permits.
    await (await open(path, "r")).close();
    return ok(null);
  } catch (cause: unknown) {
    const code =
      cause instanceof Error && "code" in cause ? cause.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR")
      return err(unreadablePlist(path, requested, "no file exists there"));
    if (code === "EACCES" || code === "EPERM")
      return err(
        new BinaryTargetError(
          path,
          `permission denied while reading plist (${code})`,
          { cause },
        ),
      );
    return err(
      new ProviderAdapterError(IDENTITY.id, "inspect_plist", { cause }),
    );
  }
};

const resolvePlistPath = async (
  target: BinaryTarget,
  requested: string | undefined,
): Promise<Result<string, AnalysisError>> => {
  try {
    const source = target.sourcePath ?? target.path;
    if (requested !== undefined && isAbsolute(requested))
      return ok(resolve(requested));
    const sourceMetadata = await stat(source);
    const root = sourceMetadata.isDirectory() ? source : dirname(target.path);
    if (requested !== undefined) return ok(resolve(root, requested));
    // A bundle target records the Info.plist its program file was declared
    // in: Contents/Info.plist, or the root plist of an iOS-style bundle.
    return ok(target.bundleInfoPlist ?? resolve(root, "Contents/Info.plist"));
  } catch (cause: unknown) {
    return err(
      new ProviderAdapterError(IDENTITY.id, "inspect_plist", { cause }),
    );
  }
};
