import { constants as fsConstants } from "node:fs";
import { createConnection } from "node:net";
import { lstat, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { requireWindowsNativeAuthority } from "../windows/WindowsNativeLoader.js";

const descriptorSchema = z.object({
  session_id: z.string().uuid(),
  pid: z.number().int().positive(),
  host: z.literal("127.0.0.1"),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(20),
  document_generation: z.number().int().nonnegative(),
  current_file: z.string().nullable(),
  cutter_version: z.string().nullable(),
  identity_status: z.literal("partial"),
});

export const CUTTER_PROVIDER_IDENTITY = {
  id: "cutter.python-plugin",
  name: "Cutter Python plugin",
  version: null,
} as const;

const responseSchema = z.object({
  ok: z.boolean(),
  session_id: z.string().uuid().optional(),
  output: z.unknown().optional(),
  current_file: z.string().nullable().optional(),
  cutter_version: z.string().nullable().optional(),
  document_generation: z.number().int().nonnegative().optional(),
  identity_status: z.literal("partial").optional(),
  error: z.string().optional(),
  message: z.string().optional(),
  execution_state: z
    .enum(["not_started", "running", "complete", "failed", "unknown"])
    .optional(),
  output_truncated: z.boolean().optional(),
});
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
export type CutterBridgeExecutionState = "complete" | "failed" | "unknown";
export interface CutterBridgeExecution {
  readonly output: unknown;
  readonly currentFile: string | null;
  readonly documentGeneration: number;
  readonly identityStatus: "partial";
  readonly cutterVersion: string | null;
  readonly executionState: CutterBridgeExecutionState;
  readonly error: string | null;
  readonly message: string | null;
  readonly outputTruncated: boolean;
}

class CutterBridgeRequestFailure extends Error {
  constructor(
    message: string,
    readonly requestSent: boolean,
  ) {
    super(message);
  }
}

export interface WindowsCutterDescriptorReader {
  verifyDirectory(directory: string): boolean;
  readDescriptor(directory: string, name: string, maxBytes: number): Buffer;
}
interface CutterBridgeClientOptions {
  readonly platform?: NodeJS.Platform;
  readonly windowsPrivateReader?: WindowsCutterDescriptorReader;
}

export type CutterBridgeSession = Omit<
  z.infer<typeof descriptorSchema>,
  "token" | "host" | "port"
>;
export interface CutterBridgeDiscovery {
  readonly sessions: readonly CutterBridgeSession[];
  readonly bridge_directory: string;
  readonly discovery_status:
    | "sessions_found"
    | "no_live_bridge_found"
    | "bridge_directory_unavailable"
    | "bridge_directory_insecure";
  readonly bridge_directory_security:
    | "private_verified"
    | "not_private"
    | "unverified_platform_acl"
    | "not_checked";
}

/** Discovers and communicates with REA Python bridge plugins in live Cutter processes. */
export class CutterBridgeClient {
  readonly #directory: string;
  readonly #platform: NodeJS.Platform;
  readonly #windowsPrivateReader: WindowsCutterDescriptorReader | undefined;

  constructor(
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
    options: CutterBridgeClientOptions = {},
  ) {
    const configured = environment.REA_CUTTER_BRIDGE_DIR;
    const localAppData = environment.LOCALAPPDATA;
    this.#platform = options.platform ?? process.platform;
    this.#windowsPrivateReader =
      options.windowsPrivateReader ??
      (this.#platform === "win32"
        ? {
            verifyDirectory: (directory) =>
              z
                .object({ privateDacl: z.literal(true) })
                .safeParse(
                  requireWindowsNativeAuthority().call(
                    "cutter_bridge_verify_directory",
                    [directory],
                  ),
                ).success,
            readDescriptor: (directory, name, maxBytes) =>
              z
                .instanceof(Buffer)
                .parse(
                  requireWindowsNativeAuthority().call(
                    "cutter_bridge_read_descriptor",
                    [directory, name, maxBytes],
                  ),
                ),
          }
        : undefined);
    this.#directory =
      configured ??
      (this.#platform === "win32" && localAppData
        ? join(localAppData, "REA", "CutterBridge")
        : join(homedir(), ".cache", "rea", "cutter-bridge"));
  }

  async listSessions(): Promise<CutterBridgeDiscovery> {
    const loaded = await this.#readDescriptors();
    if (loaded.error !== undefined)
      return {
        sessions: [],
        bridge_directory: this.#directory,
        discovery_status: loaded.error,
        bridge_directory_security: loaded.security,
      };
    const descriptors = await Promise.all(
      loaded.descriptors.map(async (descriptor) => {
        try {
          const status = responseSchema.safeParse(
            await this.#request(descriptor, {
              kind: "status",
              session_id: descriptor.session_id,
            }),
          );
          if (
            !status.success ||
            !status.data.ok ||
            status.data.session_id !== descriptor.session_id
          )
            return undefined;
          return {
            session_id: descriptor.session_id,
            pid: descriptor.pid,
            document_generation:
              status.data.document_generation ?? descriptor.document_generation,
            current_file:
              status.data.current_file === undefined
                ? descriptor.current_file
                : status.data.current_file,
            cutter_version:
              status.data.cutter_version ?? descriptor.cutter_version,
            identity_status: "partial" as const,
          };
        } catch {
          return undefined;
        }
      }),
    );
    const sessions = descriptors.filter(
      (value): value is CutterBridgeSession => value !== undefined,
    );
    return {
      sessions,
      bridge_directory: this.#directory,
      discovery_status:
        sessions.length > 0 ? "sessions_found" : "no_live_bridge_found",
      bridge_directory_security: loaded.security,
    };
  }

  async execute(input: {
    readonly sessionId: string;
    readonly expectedGeneration: number;
    readonly command: string;
    readonly json: boolean;
    readonly signal?: AbortSignal;
  }): Promise<CutterBridgeExecution> {
    input.signal?.throwIfAborted();
    const descriptor = await this.#find(input.sessionId);
    input.signal?.throwIfAborted();
    let rawResponse: unknown;
    try {
      rawResponse = await this.#request(
        descriptor,
        {
          kind: "command",
          expected_generation: input.expectedGeneration,
          command: input.command,
          json: input.json,
        },
        input.signal,
      );
    } catch (cause) {
      if (!(cause instanceof CutterBridgeRequestFailure) || !cause.requestSent)
        throw cause;
      return {
        output: null,
        currentFile: descriptor.current_file,
        documentGeneration: input.expectedGeneration,
        identityStatus: "partial",
        cutterVersion: descriptor.cutter_version,
        executionState: "unknown",
        error: "transport-response-missing",
        message: `${cause.message}; the command may have completed; do not retry automatically`,
        outputTruncated: false,
      };
    }
    const parsed = responseSchema.safeParse(rawResponse);
    if (!parsed.success)
      return {
        output: null,
        currentFile: descriptor.current_file,
        documentGeneration: input.expectedGeneration,
        identityStatus: "partial",
        cutterVersion: descriptor.cutter_version,
        executionState: "unknown",
        error: "malformed-bridge-response",
        message:
          "Cutter may have completed the command, but its response was invalid; do not retry automatically",
        outputTruncated: false,
      };
    const response = parsed.data;
    if (response.error === "active-document-generation-changed")
      throw new Error(
        "Cutter's active document generation changed. List sessions again and select the current generation.",
      );
    return {
      output: response.output ?? null,
      currentFile:
        response.current_file === undefined
          ? descriptor.current_file
          : response.current_file,
      documentGeneration:
        response.document_generation ?? input.expectedGeneration,
      identityStatus: "partial",
      cutterVersion: response.cutter_version ?? descriptor.cutter_version,
      executionState: response.ok
        ? response.execution_state === undefined ||
          response.execution_state === "complete"
          ? "complete"
          : "unknown"
        : response.execution_state === "failed"
          ? "failed"
          : "unknown",
      error: response.ok ? null : (response.error ?? "cutter-command-failed"),
      message: response.message ?? null,
      outputTruncated: response.output_truncated ?? false,
    };
  }

  async #find(sessionId: string): Promise<z.infer<typeof descriptorSchema>> {
    const sessions = await this.listDescriptors();
    const descriptor = sessions.find(
      (candidate) => candidate.session_id === sessionId,
    );
    if (descriptor === undefined)
      throw new Error("Cutter bridge session is unavailable or stale");
    return descriptor;
  }

  async listDescriptors(): Promise<
    readonly z.infer<typeof descriptorSchema>[]
  > {
    const loaded = await this.#readDescriptors();
    return loaded.descriptors;
  }

  async #readDescriptors(): Promise<{
    readonly descriptors: readonly z.infer<typeof descriptorSchema>[];
    readonly security:
      | "private_verified"
      | "not_private"
      | "unverified_platform_acl"
      | "not_checked";
    readonly error?:
      | "bridge_directory_unavailable"
      | "bridge_directory_insecure";
  }> {
    let directoryInfo;
    try {
      directoryInfo = await lstat(this.#directory);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT")
        return { descriptors: [], security: "not_checked" };
      return {
        descriptors: [],
        security: "not_checked",
        error: "bridge_directory_unavailable",
      };
    }
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
      return {
        descriptors: [],
        security: "not_private",
        error: "bridge_directory_insecure",
      };
    const currentUid =
      this.#platform !== "win32" ? process.getuid?.() : undefined;
    const posix = currentUid !== undefined;
    if (
      posix &&
      (directoryInfo.uid !== currentUid || (directoryInfo.mode & 0o077) !== 0)
    )
      return {
        descriptors: [],
        security: "not_private",
        error: "bridge_directory_insecure",
      };
    let security:
      | "private_verified"
      | "not_private"
      | "unverified_platform_acl" = posix
      ? "private_verified"
      : "unverified_platform_acl";
    if (!posix) {
      if (
        this.#platform !== "win32" ||
        this.#windowsPrivateReader === undefined
      )
        return {
          descriptors: [],
          security,
          error: "bridge_directory_insecure",
        };
      try {
        if (!this.#windowsPrivateReader.verifyDirectory(this.#directory))
          return {
            descriptors: [],
            security: "not_private",
            error: "bridge_directory_insecure",
          };
        security = "private_verified";
      } catch {
        return {
          descriptors: [],
          security,
          error: "bridge_directory_insecure",
        };
      }
    }
    let entries: string[];
    try {
      entries = await readdir(this.#directory);
    } catch {
      return {
        descriptors: [],
        security: "not_checked",
        error: "bridge_directory_unavailable",
      };
    }
    const loaded = await Promise.all(
      entries
        .filter((entry) => /^cutter-\d+-[0-9a-f-]{36}\.json$/iu.test(entry))
        .map(async (entry) => {
          let file;
          try {
            let bytes: Buffer;
            if (this.#platform === "win32") {
              if (this.#windowsPrivateReader === undefined) return undefined;
              bytes = this.#windowsPrivateReader.readDescriptor(
                this.#directory,
                entry,
                MAX_DESCRIPTOR_BYTES,
              );
            } else {
              const flags =
                fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
              file = await open(join(this.#directory, entry), flags);
              const info = await file.stat();
              if (
                !info.isFile() ||
                info.size > MAX_DESCRIPTOR_BYTES ||
                info.uid !== currentUid ||
                (info.mode & 0o077) !== 0
              )
                return undefined;
              bytes = await file.readFile();
            }
            if (bytes.byteLength > MAX_DESCRIPTOR_BYTES) return undefined;
            const parsed = descriptorSchema.safeParse(
              JSON.parse(bytes.toString("utf8")) as unknown,
            );
            if (
              !parsed.success ||
              entry !==
                `cutter-${parsed.data.pid}-${parsed.data.session_id}.json`
            )
              return undefined;
            return parsed.data;
          } catch {
            return undefined;
          } finally {
            await file?.close().catch(() => undefined);
          }
        }),
    );
    return {
      descriptors: loaded.filter(
        (value): value is z.infer<typeof descriptorSchema> =>
          value !== undefined,
      ),
      security,
    };
  }

  #request(
    descriptor: z.infer<typeof descriptorSchema>,
    request: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const connection = createConnection({
        host: descriptor.host,
        port: descriptor.port,
      });
      let payload = "";
      let settled = false;
      let requestSent = false;
      const finish = (complete: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        complete();
      };
      const rejectRequest = (message: string): void =>
        finish(() =>
          reject(new CutterBridgeRequestFailure(message, requestSent)),
        );
      const timer = setTimeout(() => {
        rejectRequest("Cutter bridge request timed out");
        connection.destroy();
      }, 25_000);
      const onAbort = (): void => {
        rejectRequest("Cutter bridge request was cancelled");
        connection.destroy();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      connection.setEncoding("utf8");
      connection.once("connect", () => {
        requestSent = true;
        connection.write(
          `${JSON.stringify({ ...request, token: descriptor.token })}\n`,
        );
      });
      connection.on("data", (chunk: string) => {
        payload += chunk;
        if (Buffer.byteLength(payload, "utf8") > 16 * 1024 * 1024) {
          connection.destroy(
            new Error(
              "Cutter bridge response exceeded its framed transport limit",
            ),
          );
          return;
        }
        const lineEnd = payload.indexOf("\n");
        if (lineEnd < 0) return;
        connection.end();
        try {
          const response: unknown = JSON.parse(payload.slice(0, lineEnd));
          finish(() => resolve(response));
        } catch {
          rejectRequest("Cutter bridge returned malformed JSON");
        }
      });
      connection.once("error", (cause) =>
        rejectRequest(`Cutter bridge is unavailable: ${cause.message}`),
      );
      connection.once("close", () =>
        rejectRequest(
          "Cutter bridge closed before returning a complete response",
        ),
      );
    });
  }
}
