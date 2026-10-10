import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import { access, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExecutionOptions,
  ProviderAvailability,
} from "../application/AnalysisProvider.js";
import {
  createAnalysisExecution,
  type AnalysisExecution,
} from "../application/AnalysisProvider.js";
import type { ApktoolRequest } from "../domain/apktool/apktoolResourceAnalysis.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  execFileOutput,
  execFileOutputFailure,
} from "../process/ExecFileOutput.js";
import {
  ApktoolConfigurationFailure,
  inspectApktoolClient,
  resolveApktoolCommand,
  type ApktoolCommandSelection,
  type ApktoolClientIdentity,
} from "./ApktoolConfiguration.js";
import {
  parseApktoolYml,
  parseDecodedStrings,
  parseManifestPackage,
} from "./ApktoolDecodeOutput.js";

/** Stable identity for the Apktool resource-decoding provider. */
export const APKTOOL_PROVIDER_IDENTITY = {
  id: "apktool",
  name: "Apktool",
  version: null,
} as const;

const DECODE_TIMEOUT_MS = 600_000;
const DECODE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 512 * 1024;
const STRINGS_XML_MAX_BYTES = 8 * 1024 * 1024;
const MAX_STRINGS = 2_000;
const MAX_DECODED_FILES_COUNTED = 100_000;
const STDERR_EXCERPT_BYTES = 512;

/** Stream a local file digest without retaining large APKs in memory. */
const sha256File = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

interface DecodeLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

const runApktool = async (
  operation: string,
  command: string,
  arguments_: readonly string[],
  limits: DecodeLimits,
  signal: AbortSignal | undefined,
): Promise<Result<{ stdout: string; stderr: string }, AnalysisError>> => {
  if (signal?.aborted === true)
    return err(new AnalysisCancelledError(operation));
  const abortReason = signal?.reason;
  try {
    return ok(
      await execFileOutput(command, arguments_, {
        timeout: limits.timeoutMs,
        maxBuffer: limits.maxOutputBytes,
        stopSignal: "SIGTERM",
        ...(signal === undefined ? {} : { signal }),
      }),
    );
  } catch (cause) {
    if (abortReason !== undefined)
      return err(new AnalysisCancelledError(operation, { cause: abortReason }));
    const failure = execFileOutputFailure(cause);
    if (failure === undefined)
      return err(
        new AnalysisProtocolError(`apktool failed for ${operation}`, { cause }),
      );
    if (failure.outputTruncated)
      return err(
        new AnalysisResourceConstraintError(
          operation,
          "memory",
          `apktool output exceeded the ${String(limits.maxOutputBytes)}-byte capture budget`,
          { max_output_bytes: limits.maxOutputBytes },
          { cause },
        ),
      );
    const excerpt = failure.stderr.trim().slice(0, STDERR_EXCERPT_BYTES);
    if (failure.killed)
      return err(
        new AnalysisTimeoutError(operation, limits.timeoutMs, { cause }),
      );
    return err(
      new AnalysisUnsupportedTargetError(
        operation,
        command,
        excerpt === ""
          ? `apktool exited with code ${String(failure.code)} for ${operation}`
          : excerpt,
        { cause },
      ),
    );
  }
};

/** Count files in the decoded workspace with a hard ceiling. */
const countDecodedFiles = async (
  root: string,
): Promise<{ count: number; capped: boolean }> => {
  let count = 0;
  let capped = false;
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (count >= MAX_DECODED_FILES_COUNTED) {
        capped = true;
        return;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) count += 1;
    }
  };
  await walk(root);
  return { count, capped };
};

/** Locale codes present as res/values-<locale>/strings.xml. */
const listStringLocales = async (
  workspace: string,
): Promise<readonly string[]> => {
  const res = join(workspace, "res");
  const entries = await readdir(res, { withFileTypes: true }).catch(() => []);
  const locales: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^values-(.+)$/u.exec(entry.name);
    if (match === null) continue;
    const strings = join(res, entry.name, "strings.xml");
    if (
      await access(strings).then(
        () => true,
        () => false,
      )
    )
      locales.push(match[1]!);
  }
  return locales.sort();
};

export interface ApktoolProviderOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/**
 * Apktool resource decoding over a caller-selected launcher.
 *
 * Decoding happens in a provider-owned temporary workspace that is removed
 * once the requested facts are projected; smali production is skipped
 * (`--no-src`) because Java-source recovery belongs to the JADX family.
 */
export class ApktoolProvider {
  private readonly environment: Readonly<Record<string, string | undefined>>;

  constructor(options: ApktoolProviderOptions = {}) {
    this.environment = options.environment ?? process.env;
  }

  private selection(): ApktoolCommandSelection {
    return resolveApktoolCommand(this.environment);
  }

  /** Probe the selected apktool launcher; decodes nothing. */
  async inspectAvailability(
    signal?: AbortSignal,
  ): Promise<ProviderAvailability> {
    const selection = this.selection();
    try {
      await inspectApktoolClient(selection, signal);
      return {
        status: "available",
        code: null,
        reason: null,
        diagnostics: {
          selected_command: selection.command,
          command_source: selection.commandSource,
        },
      };
    } catch (cause) {
      if (cause instanceof ApktoolConfigurationFailure)
        return {
          status: "unavailable",
          code:
            cause.code === "command_missing"
              ? "executable_missing"
              : cause.code === "not_absolute"
                ? "not_configured"
                : "version_unresolved",
          reason: cause.message,
          diagnostics: { ...cause.diagnostics },
        };
      throw cause;
    }
  }

  /** The provider owns only per-call workspaces; they are removed in-flight. */
  async close(): Promise<void> {}

  async execute(
    request: ApktoolRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const signal = options?.signal;
    if (signal?.aborted === true)
      return err(new AnalysisCancelledError(request.operation));
    const selection = this.selection();
    let identity: ApktoolClientIdentity;
    try {
      identity = await inspectApktoolClient(selection, signal);
    } catch (cause) {
      if (cause instanceof ApktoolConfigurationFailure)
        return err(
          new AnalysisCapabilityUnavailableError(
            APKTOOL_PROVIDER_IDENTITY.id,
            request.operation,
            typeof cause.diagnostics.remediation === "string"
              ? `${cause.message} ${cause.diagnostics.remediation}`
              : cause.message,
            { cause },
          ),
        );
      return err(
        new AnalysisProtocolError(
          `apktool version probe failed for ${request.operation}`,
          { cause },
        ),
      );
    }
    const client = {
      command: selection.command,
      command_source: selection.commandSource,
      apktool_version: identity.version,
    };
    const provider = {
      ...APKTOOL_PROVIDER_IDENTITY,
      version: identity.version,
    };
    if (request.operation === "inspect_apktool_client")
      return ok(createAnalysisExecution({ client }, provider));
    return this.decodeResources(
      request.operation,
      selection,
      client,
      provider,
      request.input,
      signal,
    );
  }

  private async decodeResources(
    operation: "decode_android_resources",
    selection: ApktoolCommandSelection,
    client: {
      command: string;
      command_source: string;
      apktool_version: string | null;
    },
    provider: { id: string; name: string; version: string | null },
    input: {
      readonly path: string;
      readonly include_strings: boolean;
      readonly locale?: string | undefined;
    },
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const info = await stat(input.path).then(
      (value) => value,
      () => null,
    );
    if (info === null || !info.isFile())
      return err(
        new AnalysisInputError(operation, {
          cause: new Error(
            `The selected APK is not a readable file: ${input.path}`,
          ),
        }),
      );
    const readable = await access(input.path, fsConstants.R_OK).then(
      () => true,
      () => false,
    );
    if (!readable)
      return err(
        new AnalysisInputError(operation, {
          cause: new Error(`The selected APK is not readable: ${input.path}`),
        }),
      );
    const sha256 = await sha256File(input.path);
    const workspace = await mkdtemp(join(tmpdir(), "rea-apktool-"));
    let cleanupFailure: string | null = null;
    // The workspace is removed before the result is returned, so an
    // unremovable workspace is reported instead of silently abandoned.
    const removeWorkspace = async (): Promise<void> => {
      await rm(workspace, { recursive: true, force: true }).catch(() => {
        cleanupFailure = `The decode workspace could not be removed: ${workspace}`;
      });
    };
    try {
      const decoded = await runApktool(
        operation,
        selection.command,
        ["d", "--no-src", "-f", "-o", workspace, input.path],
        {
          timeoutMs: DECODE_TIMEOUT_MS,
          maxOutputBytes: DECODE_MAX_OUTPUT_BYTES,
        },
        signal,
      );
      if (!decoded.ok) {
        await removeWorkspace();
        return decoded;
      }
      const yml = await readFile(join(workspace, "apktool.yml"), "utf8").catch(
        () => null,
      );
      if (yml === null) {
        await removeWorkspace();
        return err(
          new AnalysisProtocolError(
            `apktool produced no apktool.yml in its workspace; the target may not be a decodable APK: ${input.path}`,
          ),
        );
      }
      const metadata = parseApktoolYml(yml);
      const manifestPath = join(workspace, "AndroidManifest.xml");
      const manifestRaw = await readFile(manifestPath, "utf8").catch(
        () => null,
      );
      const manifest =
        manifestRaw === null
          ? null
          : manifestRaw.length > MANIFEST_MAX_BYTES
            ? manifestRaw.slice(0, MANIFEST_MAX_BYTES)
            : manifestRaw;
      const packageName =
        manifestRaw === null ? null : parseManifestPackage(manifestRaw);
      const locales = await listStringLocales(workspace);
      const stringsDirectory =
        input.locale === undefined ? "values" : `values-${input.locale}`;
      const stringsPath = join(
        workspace,
        "res",
        stringsDirectory,
        "strings.xml",
      );
      const stringsXml = input.include_strings
        ? await readFile(stringsPath, "utf8").then(
            (text) => (text.length > STRINGS_XML_MAX_BYTES ? null : text),
            () => null,
          )
        : null;
      const parsedStrings =
        stringsXml === null
          ? { entries: [], unparsedCount: 0 }
          : parseDecodedStrings(stringsXml);
      const bounded = parsedStrings.entries.slice(0, MAX_STRINGS);
      const files = await countDecodedFiles(workspace);
      const coverage =
        (stringsXml !== null && parsedStrings.entries.length > MAX_STRINGS) ||
        (manifestRaw !== null && manifestRaw.length > MANIFEST_MAX_BYTES) ||
        parsedStrings.unparsedCount > 0 ||
        files.capped
          ? "partial"
          : "complete";
      await removeWorkspace();
      return ok(
        createAnalysisExecution(
          {
            client,
            target: { path: input.path, bytes: info.size, sha256 },
            metadata: {
              version_name: metadata.versionName,
              version_code: metadata.versionCode,
              min_sdk_version: metadata.minSdkVersion,
              target_sdk_version: metadata.targetSdkVersion,
              package_name: packageName,
            },
            manifest,
            strings: bounded,
            locale: input.locale ?? null,
            locales,
            decoded_file_count: files.count,
            coverage,
          },
          provider,
          {
            limitations: [
              "Decoding skips smali (--no-src); Java-source recovery belongs to the JADX family",
              ...(input.locale !== undefined &&
              stringsXml === null &&
              input.include_strings
                ? [`No strings.xml was found for locale ${input.locale}`]
                : []),
              ...(input.include_strings &&
              stringsXml === null &&
              input.locale === undefined
                ? [
                    "No default res/values/strings.xml was found in the decoded workspace",
                  ]
                : []),
              ...(parsedStrings.unparsedCount > 0
                ? [
                    `${String(parsedStrings.unparsedCount)} string entries with nested markup were not projected`,
                  ]
                : []),
              ...(parsedStrings.entries.length > MAX_STRINGS
                ? [
                    `strings reports the first ${String(MAX_STRINGS)} of ${String(parsedStrings.entries.length)} entries`,
                  ]
                : []),
              ...(manifestRaw !== null &&
              manifestRaw.length > MANIFEST_MAX_BYTES
                ? [
                    `manifest is truncated at ${String(MANIFEST_MAX_BYTES)} bytes`,
                  ]
                : []),
              ...(files.capped
                ? [
                    `decoded_file_count is capped at ${String(MAX_DECODED_FILES_COUNTED)}`,
                  ]
                : []),
              ...(cleanupFailure === null ? [] : [cleanupFailure]),
            ],
          },
        ),
      );
    } catch (cause) {
      await removeWorkspace();
      throw cause;
    }
  }
}
