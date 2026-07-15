import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";

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
  AnalysisTimeoutError,
  ProviderAdapterError,
  type AnalysisError,
} from "../domain/errors.js";
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
import { parsePlistJson } from "./parsers/plist.js";
import {
  architectureLocations,
  inspectNativeMacho,
} from "./NativeMachoInspection.js";

/** Public identity committed by macOS-native inspection observations. */
export const NATIVE_MACOS_PROVIDER_IDENTITY: ProviderIdentity = Object.freeze({
  id: "native-macos",
  name: "macOS native inspection utilities",
  version: null,
});
const IDENTITY = NATIVE_MACOS_PROVIDER_IDENTITY;
const TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 4 * 1024 * 1024;

/** Read-only semantic provider composed from Xcode command-line utilities. */
export class NativeMacOSProvider implements AnalysisProvider {
  readonly #capabilities: readonly CapabilityDescriptor[];

  constructor(
    private readonly runner: NativeCommandRunner = new XcrunCommandRunner(),
    platform: NodeJS.Platform = process.platform,
  ) {
    const available = platform === "darwin";
    this.#capabilities = Object.freeze(
      NATIVE_TOOL_CONTRACTS.map((contract): CapabilityDescriptor => {
        const availability = available
          ? ({ available: true, reason: null } as const)
          : ({
              available: false,
              reason: "Native macOS utilities require macOS.",
            } as const);
        return Object.freeze({
          provider: IDENTITY,
          operation: contract.name,
          inputContractVersion: 1,
          outputContractVersion: 1,
          ...availability,
          pagination: "none" as const,
          exhaustive: contract.name !== "inspect_macho",
          effects: Object.freeze({
            mutatesArtifact: false,
            launchesProcess: true,
            mayShowUi: false,
            mayAccessNetwork: false,
            mayWriteFilesystem: false,
            changesPermissions: false,
            requiresRoot: false,
          }),
          limits: Object.freeze({
            maxResults: contract.name === "demangle_swift" ? 500 : null,
            maxPayloadBytes: OUTPUT_LIMIT,
            timeoutMs: TIMEOUT_MS,
          }),
          limitations: Object.freeze([
            "Availability and textual formats depend on the installed macOS/Xcode toolchain.",
          ]),
        });
      }),
    );
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
    if (!isNativeOperation(operation))
      return err(
        new AnalysisCapabilityUnavailableError(
          IDENTITY.id,
          operation,
          "Operation is not implemented by native macOS tools.",
        ),
      );
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
    const requirements = await this.#run(
      "inspect_signature",
      "codesign",
      ["-d", "-r-", this.target.path],
      { signal, acceptNonZero: true },
    );
    if (!requirements.ok) return requirements;
    const entitlements = await this.#run(
      "inspect_signature",
      "codesign",
      ["-d", "--entitlements", ":-", this.target.path],
      { signal, acceptNonZero: true },
    );
    if (!entitlements.ok) return entitlements;
    const unsigned = /not signed at all|code object is not signed/iu.test(
      `${display.value.stdout}\n${display.value.stderr}`,
    );
    const parsed = parseCodeSignature(
      `${display.value.stdout}\n${display.value.stderr}`,
      unsigned,
    );
    const requirementText =
      /designated\s*=>\s*(.+)$/mu.exec(
        `${requirements.value.stdout}\n${requirements.value.stderr}`,
      )?.[1] ?? null;
    const entitlementValue = parseEntitlements(
      `${entitlements.value.stdout}\n${entitlements.value.stderr}`,
    );
    const provenance = [
      display.value,
      requirements.value,
      entitlements.value,
    ].map((capture) => invocation(capture, this.target.path));
    const result = inspectSignatureSchema.parse({
      ...parsed,
      designated_requirement: requirementText,
      entitlements: entitlementValue,
      provenance,
    });
    return ok({
      result: jsonValueSchema.parse(result),
      provenance,
      limitations: result.limitations,
      locations: [],
    });
  }

  async #inspectPlist(
    parameters: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    const requested = parameters.relative_path;
    if (typeof requested !== "string")
      return err(
        new AnalysisOutputError(
          "inspect_plist",
          "relative_path was not a string",
        ),
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
    const capture = await this.#run(
      "inspect_plist",
      "plutil",
      ["-convert", "json", "-o", "-", "--", plist.value],
      { signal },
    );
    if (!capture.ok) return capture;
    const parsed = parsePlistJson(capture.value.stdout);
    const provenance = [classified.value, capture.value].map((item) =>
      invocation(item, plist.value, "$PLIST"),
    );
    const result = inspectPlistSchema.parse({
      format: /binary property list/iu.test(classified.value.stdout)
        ? "binary"
        : /XML|text/iu.test(classified.value.stdout)
          ? "xml"
          : "unknown",
      ...parsed,
      source_path: requested,
      provenance,
      limitations: [],
    });
    return ok({
      result: jsonValueSchema.parse(result),
      provenance,
      limitations: [],
      locations: [{ kind: "artifact-path", path: requested }],
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
      timeoutMs: TIMEOUT_MS,
      maxOutputBytes: OUTPUT_LIMIT,
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
  if (failure.reason === "timeout")
    return new AnalysisTimeoutError(operation, TIMEOUT_MS);
  return new ProviderAdapterError(IDENTITY.id, operation, { cause: failure });
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
  stdout_truncated: capture.stdoutTruncated,
  stderr_truncated: capture.stderrTruncated,
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
  requested: string,
): Promise<Result<string, AnalysisError>> => {
  try {
    const source = target.sourcePath ?? target.path;
    const sourceMetadata = await stat(source);
    const root = sourceMetadata.isDirectory() ? source : dirname(target.path);
    const candidate = resolve(root, requested);
    if (!within(root, candidate))
      return err(new ProviderAdapterError(IDENTITY.id, "inspect_plist"));
    const canonicalRoot = await realpath(root);
    const canonical = await realpath(candidate);
    if (!within(canonicalRoot, canonical))
      return err(new ProviderAdapterError(IDENTITY.id, "inspect_plist"));
    return ok(canonical);
  } catch (cause: unknown) {
    return err(
      new ProviderAdapterError(IDENTITY.id, "inspect_plist", { cause }),
    );
  }
};

const within = (root: string, candidate: string): boolean => {
  const child = relative(root, candidate);
  return (
    child === "" ||
    (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))
  );
};
