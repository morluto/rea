import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  opendir,
  open,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FileHandle } from "node:fs/promises";

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
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { err, ok, type Result } from "../domain/result.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  openRegularFile,
  sameRegularFileState,
} from "../filesystem/RegularFile.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import type { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import {
  ApktoolConfigurationFailure,
  apktoolConfigurationAvailability,
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
const MAX_DECODED_ENTRIES_VISITED = 100_000;
const STDERR_EXCERPT_BYTES = 512;

const throwIfCancelled = (
  operation: string,
  signal: AbortSignal | undefined,
): void => {
  if (signal?.aborted === true) throw new AnalysisCancelledError(operation);
};

/** Read at most the byte budget plus one byte, before decoding UTF-8. */
const readBoundedText = async (
  path: string,
  budget: number,
  operation: string,
  signal: AbortSignal | undefined,
): Promise<{ text: string | null; truncated: boolean }> => {
  const file = await open(path, "r").catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  });
  if (file === null) return { text: null, truncated: false };
  try {
    throwIfCancelled(operation, signal);
    const bytes = Buffer.alloc(budget + 1);
    let length = 0;
    while (length < bytes.length) {
      throwIfCancelled(operation, signal);
      const result = await file.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    throwIfCancelled(operation, signal);
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
  environment: Readonly<Record<string, string | undefined>>,
  onCleanupOwner: (owner: ProviderProcessSupervisor) => void,
): Promise<Result<{ stdout: string; stderr: string }, AnalysisError>> => {
  if (signal?.aborted === true)
    return err(new AnalysisCancelledError(operation));
  try {
    const output = await runOwnedCommand(
      {
        command,
        arguments: arguments_,
        runId: randomUUID(),
        hostEnvironment: { ...process.env, ...environment },
      },
      {
        timeoutMs: limits.timeoutMs,
        diagnosticBytes: limits.maxOutputBytes,
      },
      (signal === undefined ? {} : { signal }),
    );
    return ok({ stdout: output.stdout.text, stderr: output.stderr.text });
  } catch (cause) {
    if (!(cause instanceof OwnedCommandFailure))
      return err(
        new AnalysisProtocolError(`apktool failed for ${operation}`, { cause }),
      );
    if (cause.cleanupOwner !== undefined) onCleanupOwner(cause.cleanupOwner);
    const output = cause.snapshot;
    const capturedOutput =
      output === null
        ? undefined
        : {
            stdout: output.stdout.text,
            stderr: output.stderr.text,
            truncated: output.diagnosticTruncated === true,
            stdout_bytes: output.stdout.bytes,
            stderr_bytes: output.stderr.bytes,
            exit_code: output.exitCode ?? null,
            signal: output.signal ?? null,
          };
    const cleanup =
      cause.cleanupFailure === null
        ? undefined
        : {
            reason: cause.cleanupFailure,
            resources: cause.resources,
          };
    if (cause.reason === "cancelled")
      return err(
        new AnalysisCancelledError(operation, {
          cause,
          ...(cleanup === undefined ? {} : { cleanup }),
          ...(capturedOutput === undefined ? {} : { capturedOutput }),
        }),
      );
    if (cause.reason === "timeout")
      return err(
        new AnalysisTimeoutError(operation, limits.timeoutMs, {
          cause,
          ...(cleanup === undefined ? {} : { cleanup }),
          ...(capturedOutput === undefined ? {} : { capturedOutput }),
        }),
      );
    if (cause.reason === "output-limit")
      return err(
        new AnalysisResourceConstraintError(
          operation,
          "memory",
          `apktool output exceeded the ${String(limits.maxOutputBytes)}-byte capture budget`,
          { max_output_bytes: limits.maxOutputBytes },
          {
            cause,
            ...(cleanup === undefined ? {} : { cleanup }),
            ...(capturedOutput === undefined ? {} : { capturedOutput }),
          },
        ),
      );
    return err(
      new AnalysisUnsupportedTargetError(
        operation,
        command,
        output?.stderr.text.trim().slice(0, STDERR_EXCERPT_BYTES) ||
          `apktool exited with code ${String(output?.exitCode ?? "unknown")} for ${operation}`,
        {
          cause,
          ...(cleanup === undefined ? {} : { cleanup }),
          ...(capturedOutput === undefined ? {} : { capturedOutput }),
        },
      ),
    );
  }
};

/** Count files while bounding streamed directory-entry traversal. */
const countDecodedFiles = async (
  root: string,
  signal: AbortSignal | undefined,
  operation: string,
): Promise<{
  count: number;
  capped: boolean;
  locales: readonly string[];
}> => {
  let count = 0;
  let capped = false;
  let visited = 0;
  const directories = [root];
  const locales: string[] = [];
  while (directories.length > 0 && !capped) {
    throwIfCancelled(operation, signal);
    const directory = directories.pop()!;
    for await (const entry of await opendir(directory)) {
      throwIfCancelled(operation, signal);
      if (visited >= MAX_DECODED_ENTRIES_VISITED) {
        capped = true;
        break;
      }
      visited += 1;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
        if (directory === join(root, "res")) {
          const match = /^values-(.+)$/u.exec(entry.name);
          if (
            match !== null &&
            (await access(join(path, "strings.xml")).then(
              () => true,
              () => false,
            ))
          )
            locales.push(match[1]!);
        }
      } else if (entry.isFile()) count += 1;
    }
  }
  return { count, capped, locales: locales.sort() };
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
  readonly #pendingCommandOwners = new Map<ProviderProcessSupervisor, string>();
  readonly #shutdown = new AbortController();
  readonly #active = new Set<Promise<void>>();
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: ApktoolProviderOptions = {}) {
    this.environment = snapshotEnvironment(options.environment ?? process.env);
    this.removeWorkspace =
      options.removeWorkspace ??
      ((path) => rm(path, { recursive: true, force: true }));
  }

  private selection(): ApktoolCommandSelection {
    return resolveApktoolCommand(this.environment);
  }

  /** Probe the selected apktool launcher; decodes nothing. */
  inspectAvailability(signal?: AbortSignal): Promise<ProviderAvailability> {
    if (this.#closing)
      return Promise.reject(
        new AnalysisCancelledError("inspect_apktool_client"),
      );
    const operationSignal =
      signal === undefined
        ? this.#shutdown.signal
        : AbortSignal.any([signal, this.#shutdown.signal]);
    return this.#track(this.#inspectAvailability(operationSignal));
  }

  async #inspectAvailability(
    signal: AbortSignal,
  ): Promise<ProviderAvailability> {
    const selection = this.selection();
    try {
      await inspectApktoolClient(selection, signal, this.environment);
      throwIfCancelled("inspect_apktool_client", signal);
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
        return apktoolConfigurationAvailability(cause);
      throw cause;
    }
  }

  /** Retain failed cleanup ownership and retry it on close. */
  async close(): Promise<void> {
    this.#closing = true;
    this.#shutdown.abort();
    this.#closePromise ??= this.#drainAndClean().catch((cause: unknown) => {
      this.#closePromise = undefined;
      throw cause;
    });
    return this.#closePromise;
  }

  execute(
    request: ApktoolRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (this.#closing)
      return Promise.resolve(
        err(new AnalysisCancelledError(request.operation)),
      );
    const signal =
      options?.signal === undefined
        ? this.#shutdown.signal
        : AbortSignal.any([options.signal, this.#shutdown.signal]);
    return this.#track(this.#execute(request, signal));
  }

  async #execute(
    request: ApktoolRequest,
    signal: AbortSignal,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (signal?.aborted === true)
      return err(new AnalysisCancelledError(request.operation));
    const selection = this.selection();
    let identity: ApktoolClientIdentity;
    try {
      identity = await inspectApktoolClient(
        selection,
        signal,
        this.environment,
      );
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
    if (signal.aborted)
      return err(new AnalysisCancelledError(request.operation));
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

  #track<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#active.add(settled);
    void settled.then(() => this.#active.delete(settled));
    return operation;
  }

  async #drainAndClean(): Promise<void> {
    await Promise.all(this.#active);
    const failures: unknown[] = [];
    for (const [owner, root] of this.#pendingCommandOwners) {
      try {
        const stopped = await owner.stop();
        if (stopped.status === "incomplete") throw new Error(stopped.reason);
        this.#pendingCommandOwners.delete(owner);
      } catch (cause) {
        failures.push(
          new Error(
            `apktool process cleanup remains incomplete for ${root}: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
          ),
        );
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Apktool process cleanup failed");
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
    const root = await mkdtemp(join(tmpdir(), "rea-apktool-"));
    this.workspaces.add(root);
    const workspace = join(root, "decoded");
    const snapshot = join(root, "input.apk");
    const framework = join(root, "framework");
    let cleanupFailure: string | null = null;
    // The workspace is removed before the result is returned, so an
    // unremovable workspace is reported instead of silently abandoned.
    const removeWorkspace = async (): Promise<void> => {
      if ([...this.#pendingCommandOwners.values()].includes(root)) {
        cleanupFailure = `The decode workspace is retained until its apktool process stops: ${root}`;
        return;
      }
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
        : analysisErrorWithCleanupFailure(
            failure,
            new ProviderCleanupError(
              APKTOOL_PROVIDER_IDENTITY.id,
              [root],
              { reason: cleanupFailure },
              { operation },
            ),
            operation,
          );
    let source: FileHandle | undefined;
    let sourceAdmissionFailed = false;
    try {
      throwIfCancelled(operation, signal);
      sourceAdmissionFailed = true;
      source = await openRegularFile(input.path, {
        symlinks: "follow",
        ...(signal === undefined ? {} : { signal }),
      });
      const sourceInfo = await source.stat();
      sourceAdmissionFailed = false;
      const sourceSize = sourceInfo.size;
      let copiedBytes = 0;
      const sourceHash = createHash("sha256");
      const boundedSource = new Transform({
        transform(
          chunk: Buffer,
          _encoding: BufferEncoding,
          callback: TransformCallback,
        ) {
          copiedBytes += chunk.length;
          if (copiedBytes > sourceSize) {
            callback(
              new AnalysisInputError(operation, {
                cause: new Error(
                  `The selected APK changed while being copied: ${input.path}`,
                ),
              }),
            );
            return;
          }
          sourceHash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        source.createReadStream({
          start: 0,
          end: sourceSize,
          autoClose: false,
          ...(signal === undefined ? {} : { signal }),
        }),
        boundedSource,
        createWriteStream(snapshot, { flags: "wx", mode: 0o600 }),
        signal === undefined ? {} : { signal },
      );
      const finalSourceInfo = await source.stat();
      if (
        copiedBytes !== sourceSize ||
        !sameRegularFileState(sourceInfo, finalSourceInfo)
      )
        throw new AnalysisInputError(operation, {
          cause: new Error(
            `The selected APK changed while being copied: ${input.path}`,
          ),
        });
      const sha256 = sourceHash.digest("hex");
      await source.close();
      source = undefined;
      await chmod(snapshot, 0o400);
      throwIfCancelled(operation, signal);
      const snapshotInfo = await stat(snapshot);
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
        this.environment,
        (owner) => this.#pendingCommandOwners.set(owner, root),
      );
      if (!decoded.ok) {
        await removeWorkspace();
        return err(failureWithCleanup(decoded.error));
      }
      throwIfCancelled(operation, signal);
      const yml = await readBoundedText(
        join(workspace, "apktool.yml"),
        MANIFEST_MAX_BYTES,
        operation,
        signal,
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
        operation,
        signal,
      );
      const manifest = manifestRead.text;
      const packageName =
        manifest === null ? null : parseManifestPackage(manifest);
      const stringsDirectory =
        input.locale === undefined
          ? "values"
          : `values-${localeQualifier(input.locale)}`;
      const stringsRead = input.include_strings
        ? await readBoundedText(
            join(workspace, "res", stringsDirectory, "strings.xml"),
            STRINGS_XML_MAX_BYTES,
            operation,
            signal,
          )
        : { text: null, truncated: false };
      // Do not parse an incomplete XML document as though its projection were complete.
      const stringsXml = stringsRead.truncated ? null : stringsRead.text;
      const parsedStrings =
        stringsXml === null
          ? { entries: [], unparsedCount: 0 }
          : parseDecodedStrings(stringsXml);
      const bounded = parsedStrings.entries.slice(0, MAX_STRINGS);
      const files = await countDecodedFiles(workspace, signal, operation);
      throwIfCancelled(operation, signal);
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
            locales: files.locales,
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
                    `Decoded workspace enumeration stopped after ${String(MAX_DECODED_ENTRIES_VISITED)} entries; decoded_file_count and locales may be partial`,
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
          signal?.aborted === true
            ? new AnalysisCancelledError(operation, { cause })
            : sourceAdmissionFailed
              ? new AnalysisInputError(operation, { cause })
              : cause instanceof AnalysisInputError
                ? cause
                : cause instanceof AnalysisCancelledError ||
                    cause instanceof AnalysisProtocolError
                  ? cause
                  : new AnalysisProtocolError(
                      "Apktool resource projection failed",
                      {
                        cause,
                      },
                    ),
        ),
      );
    } finally {
      await source?.close().catch(() => undefined);
    }
  }
}
