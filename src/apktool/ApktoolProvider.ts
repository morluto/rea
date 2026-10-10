import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
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

/** Read at most the byte budget plus one byte, before decoding UTF-8. */
const readBoundedText = async (
  path: string,
  budget: number,
): Promise<{ text: string | null; truncated: boolean }> => {
  const file = await open(path, "r").catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  });
  if (file === null) return { text: null, truncated: false };
  try {
    const bytes = Buffer.alloc(budget + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const truncated = length > budget;
    // A prefix may end within a UTF-8 character; omit those trailing bytes.
    const decoder = new TextDecoder("utf-8");
    return {
      text: decoder.decode(bytes.subarray(0, Math.min(length, budget)), {
        stream: truncated,
      }),
      truncated,
    };
  } finally {
    await file.close();
  }
};

const localeQualifier = (locale: string): string =>
  locale.replace(/^([a-z]{2,3})-([A-Z]{2}|[0-9]{3})$/u, "$1-r$2");

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
    if (signal?.aborted || execFileOutputFailure(cause)?.code === "ABORT_ERR")
      return err(new AnalysisCancelledError(operation, { cause }));
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
  readonly removeWorkspace?: (path: string) => Promise<void>;
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

  private readonly workspaces = new Set<string>();
  private readonly removeWorkspace: (path: string) => Promise<void>;

  constructor(options: ApktoolProviderOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.removeWorkspace =
      options.removeWorkspace ??
      ((path) => rm(path, { recursive: true, force: true }));
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

  /** Retain failed cleanup ownership and retry it on close. */
  async close(): Promise<void> {
    const failures: unknown[] = [];
    for (const path of this.workspaces) {
      try {
        await this.removeWorkspace(path);
        this.workspaces.delete(path);
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Apktool workspace cleanup failed");
  }

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
      if (cause instanceof AnalysisCancelledError) return err(cause);
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
    const root = await mkdtemp(join(tmpdir(), "rea-apktool-"));
    this.workspaces.add(root);
    const workspace = join(root, "decoded");
    const snapshot = join(root, "input.apk");
    const framework = join(root, "framework");
    let cleanupFailure: string | null = null;
    // The workspace is removed before the result is returned, so an
    // unremovable workspace is reported instead of silently abandoned.
    const removeWorkspace = async (): Promise<void> => {
      try {
        await this.removeWorkspace(root);
        this.workspaces.delete(root);
      } catch {
        cleanupFailure = `The decode workspace could not be removed: ${root}`;
      }
    };
    const failureWithCleanup = (failure: AnalysisError): AnalysisError =>
      cleanupFailure === null
        ? failure
        : failure instanceof AnalysisCancelledError
          ? new AnalysisCancelledError(operation, {
              cause: failure,
              cleanup: { reason: cleanupFailure, resources: [root] },
            })
          : new AnalysisProtocolError(failure.message, {
              cause: failure,
              cleanup: { reason: cleanupFailure, resources: [root] },
            });
    try {
      await copyFile(input.path, snapshot, fsConstants.COPYFILE_EXCL);
      await chmod(snapshot, 0o400);
      const snapshotInfo = await stat(snapshot);
      const sha256 = await sha256File(snapshot);
      await mkdir(workspace);
      await mkdir(framework);
      const decoded = await runApktool(
        operation,
        selection.command,
        [
          "d",
          "--no-src",
          "-f",
          "-o",
          workspace,
          "--frame-path",
          framework,
          snapshot,
        ],
        {
          timeoutMs: DECODE_TIMEOUT_MS,
          maxOutputBytes: DECODE_MAX_OUTPUT_BYTES,
        },
        signal,
      );
      if (!decoded.ok) {
        await removeWorkspace();
        return err(failureWithCleanup(decoded.error));
      }
      const yml = await readBoundedText(
        join(workspace, "apktool.yml"),
        MANIFEST_MAX_BYTES,
      );
      if (yml.text === null || yml.truncated) {
        throw new AnalysisProtocolError(
          `apktool produced missing or oversized apktool.yml: ${input.path}`,
        );
      }
      const metadata = parseApktoolYml(yml.text);
      const manifestRead = await readBoundedText(
        join(workspace, "AndroidManifest.xml"),
        MANIFEST_MAX_BYTES,
      );
      const manifest = manifestRead.text;
      const packageName =
        manifest === null ? null : parseManifestPackage(manifest);
      const locales = await listStringLocales(workspace);
      const stringsDirectory =
        input.locale === undefined
          ? "values"
          : `values-${localeQualifier(input.locale)}`;
      const stringsRead = input.include_strings
        ? await readBoundedText(
            join(workspace, "res", stringsDirectory, "strings.xml"),
            STRINGS_XML_MAX_BYTES,
          )
        : { text: null, truncated: false };
      // Do not parse an incomplete XML document as though its projection were complete.
      const stringsXml = stringsRead.truncated ? null : stringsRead.text;
      const parsedStrings =
        stringsXml === null
          ? { entries: [], unparsedCount: 0 }
          : parseDecodedStrings(stringsXml);
      const bounded = parsedStrings.entries.slice(0, MAX_STRINGS);
      const files = await countDecodedFiles(workspace);
      const coverage =
        (stringsXml !== null && parsedStrings.entries.length > MAX_STRINGS) ||
        manifestRead.truncated ||
        stringsRead.truncated ||
        parsedStrings.unparsedCount > 0 ||
        files.capped
          ? "partial"
          : "complete";
      await removeWorkspace();
      return ok(
        createAnalysisExecution(
          {
            client,
            target: { path: input.path, bytes: snapshotInfo.size, sha256 },
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
              stringsRead.text === null &&
              input.include_strings
                ? [`No strings.xml was found for locale ${input.locale}`]
                : []),
              ...(input.include_strings &&
              stringsRead.text === null &&
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
              ...(manifestRead.truncated
                ? [
                    `manifest is truncated at ${String(MANIFEST_MAX_BYTES)} bytes`,
                  ]
                : []),
              ...(stringsRead.truncated
                ? [
                    `strings.xml exceeds the ${String(STRINGS_XML_MAX_BYTES)}-byte projection budget`,
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
      return err(
        failureWithCleanup(
          cause instanceof AnalysisCancelledError ||
            cause instanceof AnalysisProtocolError
            ? cause
            : new AnalysisProtocolError("Apktool resource projection failed", {
                cause,
              }),
        ),
      );
    }
  }
}
