import {
  NATIVE_MACOS_PROVIDER_IDENTITY as IDENTITY,
  nativeMacOSCapabilities,
} from "./NativeMacOSProviderMetadata.js";
export { NATIVE_MACOS_PROVIDER_IDENTITY } from "./NativeMacOSProviderMetadata.js";
import { inspectAppleDispatchMetadata } from "./AppleDispatchMetadata.js";
import { observeNativeUi } from "./NativeUiObservation.js";
import { dirname, isAbsolute, resolve } from "node:path";
import { stat } from "node:fs/promises";

import { parse as parseXmlPlist } from "plist";
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
} from "../contracts/nativeToolContracts.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { EvidenceLocation } from "../domain/evidence.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import {
  demangleSwiftSchema,
  inspectPlistSchema,
  inspectSignatureSchema,
  listArchitecturesSchema,
  type NativeCommandInvocation,
} from "../domain/nativeInspection.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  NativeCommandFailure,
  XcrunCommandRunner,
  type NativeCommandCapture,
  type NativeCommandRunner,
} from "./CommandRunner.js";
import { parseCodeSignature } from "./parsers/codesign.js";
import { parseDemangledSymbols } from "./parsers/demangle.js";
import { parseLipoArchitectures } from "./parsers/lipo.js";
import { parsePlistJson, parsePlistXml } from "./parsers/plist.js";
import {
  architectureLocations,
  inspectNativeMacho,
} from "./NativeMachoInspection.js";

/** Read-only semantic provider composed from Xcode command-line utilities. */
export class NativeMacOSProvider implements AnalysisProvider {
  readonly #capabilities: readonly CapabilityDescriptor[];

  constructor(
    private readonly runner: NativeCommandRunner = new XcrunCommandRunner(),
    platform: NodeJS.Platform = process.platform,
  ) {
    this.#capabilities = nativeMacOSCapabilities(platform);
  }

  identity(): ProviderIdentity {
    return IDENTITY;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return this.#capabilities;
  }

  createClient(target: BinaryTarget): AnalysisClient {
    return new NativeMacOSClient(target, this.runner);
  }
}

class NativeMacOSClient implements AnalysisClient {
  constructor(
    private readonly target: BinaryTarget,
    private readonly runner: NativeCommandRunner,
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
      if (this.target.kind !== "executable" || this.target.format !== "mach-o")
        return err(
          new AnalysisCapabilityUnavailableError(
            IDENTITY.id,
            operation,
            "Binary Apple metadata requires Mach-O; other providers can report symbol-only metadata",
          ),
        );
      try {
        const maxRecords = z
          .number()
          .int()
          .min(1)
          .max(20000)
          .parse(parameters.max_records ?? 5000);
        const result = await inspectAppleDispatchMetadata(
          this.target,
          maxRecords,
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
    if (
      operation === "observe_native_ui" ||
      operation === "capture_native_ui_scenario"
    ) {
      const result = await observeNativeUi(this.target, operation, parameters, {
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

  close(): Promise<void> {
    return Promise.resolve();
  }

  #dispatch(
    operation: NativeToolName,
    parameters: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    switch (operation) {
      case "observe_native_ui":
      case "capture_native_ui_scenario":
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
      ["--compact", ...symbols.data],
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
    const display = await this.#run(
      "inspect_signature",
      "codesign",
      ["-d", "--verbose=4", this.target.path],
      { signal, acceptNonZero: true },
    );
    if (!display.ok) return display;
    const displayOutput = commandOutput(display.value);
    const unsigned = isUnsignedCodeSignObservation(display.value);
    const displayFailure = codeSignCaptureFailure(display.value);
    if (displayFailure !== null) return err(displayFailure);
    const requirements = await this.#run(
      "inspect_signature",
      "codesign",
      ["-d", "-r-", this.target.path],
      { signal, acceptNonZero: true },
    );
    if (!requirements.ok) return requirements;
    const requirementsFailure = codeSignCaptureFailure(requirements.value);
    if (requirementsFailure !== null) return err(requirementsFailure);
    const entitlements = await this.#run(
      "inspect_signature",
      "codesign",
      ["-d", "--entitlements", ":-", this.target.path],
      { signal, acceptNonZero: true },
    );
    if (!entitlements.ok) return entitlements;
    const entitlementsFailure = codeSignCaptureFailure(entitlements.value);
    if (entitlementsFailure !== null) return err(entitlementsFailure);
    const parsed = parseCodeSignature(displayOutput, unsigned);
    const requirementText =
      /designated\s*=>\s*(.+)$/mu.exec(
        commandOutput(requirements.value),
      )?.[1] ?? null;
    const entitlementValue = parseEntitlements(
      commandOutput(entitlements.value),
    );
    const captures = [display.value, requirements.value, entitlements.value];
    const limitations = [...parsed.limitations];
    const mixedSigning =
      !unsigned &&
      (isNonzeroUnsignedObservation(requirements.value) ||
        isNonzeroUnsignedObservation(entitlements.value));
    if (mixedSigning) {
      const slices = await this.#inspectMixedSignatureSlices(
        displayOutput,
        requirements.value.exitCode !== 0,
        entitlements.value.exitCode !== 0,
        signal,
      );
      if (!slices.ok) return slices;
      captures.push(...slices.value.captures);
      limitations.push(...slices.value.limitations);
    }
    const provenance = captures.map((capture) =>
      invocation(capture, this.target.path),
    );
    const result = inspectSignatureSchema.parse({
      ...parsed,
      designated_requirement: requirementText,
      entitlements: entitlementValue,
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
    displayOutput: string,
    requirementsUnavailable: boolean,
    entitlementsUnavailable: boolean,
    signal?: AbortSignal,
  ): Promise<Result<MixedSignatureSlices, AnalysisError>> {
    const captures: NativeCommandCapture[] = [];
    const unsigned: string[] = [];
    const unclassified: string[] = [];
    for (const architecture of codeSignArchitectures(
      displayOutput,
      this.target,
    )) {
      const slice = await this.#run(
        "inspect_signature",
        "codesign",
        ["-d", "-a", architecture, "--verbose=4", this.target.path],
        { signal, acceptNonZero: true },
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
    if (requirementsUnavailable)
      limitations.push(
        "The aggregate designated requirement is unavailable because Mach-O slices have mixed signing states.",
      );
    if (entitlementsUnavailable)
      limitations.push(
        "The aggregate entitlements are unavailable because Mach-O slices have mixed signing states.",
      );
    return ok({ captures, limitations });
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
    // such plists, so decode its lossless XML conversion instead.
    const xml =
      json.value.exitCode === 0
        ? undefined
        : await this.#run(
            "inspect_plist",
            "plutil",
            ["-convert", "xml1", "-o", "-", "--", plist.value],
            { signal },
          );
    if (xml !== undefined && !xml.ok) return xml;
    const parsed =
      xml === undefined
        ? parsePlistJson(json.value.stdout)
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
  if (failure.reason === "unavailable")
    return new AnalysisCapabilityUnavailableError(
      IDENTITY.id,
      operation,
      `${failure.tool} is unavailable through xcrun.`,
    );
  if (failure.reason === "cancelled")
    return new AnalysisCancelledError(operation);
  return new ProviderAdapterError(IDENTITY.id, operation, { cause: failure });
};

const translateCodeSignExitFailure = (
  capture: NativeCommandCapture,
): AnalysisError =>
  translateCommandFailure(
    "inspect_signature",
    new NativeCommandFailure("codesign", "nonzero-exit", capture.exitCode),
  );

const commandOutput = (capture: NativeCommandCapture): string =>
  `${capture.stdout}\n${capture.stderr}`;

const isUnsignedCodeSignObservation = (
  capture: NativeCommandCapture,
): boolean =>
  /not signed at all|code object is not signed/iu.test(commandOutput(capture));

const isNonzeroUnsignedObservation = (capture: NativeCommandCapture): boolean =>
  capture.exitCode !== null &&
  capture.exitCode !== 0 &&
  isUnsignedCodeSignObservation(capture);

const codeSignCaptureFailure = (
  capture: NativeCommandCapture,
): AnalysisError | null =>
  capture.exitCode === 0 || isNonzeroUnsignedObservation(capture)
    ? null
    : translateCodeSignExitFailure(capture);

const codeSignArchitectures = (
  displayOutput: string,
  target: BinaryTarget,
): string[] => {
  const universal = /^Format=Mach-O universal \(([^)\r\n]+)\)$/mu.exec(
    displayOutput,
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

const parseEntitlements = (output: string): JsonValue | null => {
  const start = output.indexOf("<?xml");
  const end = output.lastIndexOf("</plist>");
  if (start < 0 || end < start) return null;
  return jsonValueSchema.parse(
    parseXmlPlist(output.slice(start, end + "</plist>".length)),
  );
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
    return ok(
      requested === undefined
        ? resolve(root, "Contents/Info.plist")
        : resolve(root, requested),
    );
  } catch (cause: unknown) {
    return err(
      new ProviderAdapterError(IDENTITY.id, "inspect_plist", { cause }),
    );
  }
};
