import { mkdtempSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";

/** Redacts an exact ASCII credential even when it crosses input chunks. */
class RedactedFile {
  readonly #token: Buffer;
  #tail = Buffer.alloc(0);
  private constructor(
    private readonly handle: FileHandle,
    token: string,
    private readonly resources: ArtifactResourceScope,
    private readonly path: string,
  ) {
    this.#token = Buffer.from(token);
  }
  static async create(
    path: string,
    token: string,
    resources: ArtifactResourceScope,
  ): Promise<RedactedFile> {
    return new RedactedFile(
      await open(path, "wx", 0o600),
      token,
      resources,
      path,
    );
  }
  #write(bytes: Buffer): void {
    let offset = 0;
    while (offset < bytes.length)
      offset += writeSync(this.handle.fd, bytes, offset);
  }
  write(chunk: Buffer): void {
    let input = Buffer.concat([this.#tail, chunk]);
    let safe = Math.max(0, input.length - this.#token.length + 1);
    while (safe > 0) {
      const match = input.indexOf(this.#token);
      if (match < 0 || match >= safe) break;
      this.#write(input.subarray(0, match));
      this.#write(Buffer.from("[REDACTED]"));
      input = input.subarray(match + this.#token.length);
      safe = Math.max(0, input.length - this.#token.length + 1);
    }
    this.#write(input.subarray(0, safe));
    this.#tail = Buffer.from(input.subarray(safe));
  }
  async close(complete: boolean, rollbackDirectory?: string): Promise<void> {
    let writeFailure: { readonly cause: unknown } | undefined;
    try {
      let tail = this.#tail;
      if (!complete) {
        for (
          let n = Math.min(tail.length, this.#token.length - 1);
          n > 0;
          n--
        ) {
          if (
            tail.subarray(tail.length - n).equals(this.#token.subarray(0, n))
          ) {
            tail = Buffer.concat([
              tail.subarray(0, tail.length - n),
              Buffer.from("[REDACTED]"),
            ]);
            break;
          }
        }
      }
      this.#write(tail);
    } catch (cause) {
      writeFailure = { cause };
    }
    let handleClosed = false;
    const outputResource = `Ghidra diagnostic output ${this.path}`;
    const directoryResource =
      rollbackDirectory === undefined
        ? undefined
        : `Ghidra diagnostic export directory ${rollbackDirectory}`;
    const lease = new AnalysisCleanupLease(
      async () => {
        if (!handleClosed) {
          await this.handle.close();
          handleClosed = true;
        }
        if (rollbackDirectory !== undefined)
          await rm(rollbackDirectory, { recursive: true, force: true });
      },
      {
        get cleanupResources() {
          return [
            ...(handleClosed ? [] : [outputResource]),
            ...(directoryResource === undefined ? [] : [directoryResource]),
          ];
        },
      },
    );
    const closed = await this.resources.release({
      kind: "lease",
      resource: outputResource,
      lease,
    });
    if (closed.kind === "failed") {
      if (writeFailure !== undefined)
        throw new AggregateError(
          [writeFailure.cause, closed.cause],
          `Diagnostic output write failed: ${String(writeFailure.cause)}; close failed: ${String(closed.cause)}`,
        );
      throw closed.cause;
    }
    if (writeFailure !== undefined) throw writeFailure.cause;
  }
}

type FileStatus = {
  status: "complete" | "incomplete" | "captured" | "unavailable" | "error";
  reason?: string;
};

/** Caller-owned, opt-in diagnostics; no runtime files or credentials are retained. */
export class GhidraDiagnosticExport {
  readonly path: string;
  readonly #token: string;
  readonly #identity: {
    run_id: string;
    target_sha256: string;
    profile_digest: string;
  };
  readonly #streams: Record<"stdout" | "stderr", RedactedFile>;
  readonly #errors: Partial<Record<"stdout" | "stderr", string>> = {};
  #finalizing = false;
  private constructor(
    path: string,
    token: string,
    identity: { run_id: string; target_sha256: string; profile_digest: string },
    private readonly resources: ArtifactResourceScope,
    streams: Record<"stdout" | "stderr", RedactedFile>,
  ) {
    this.path = path;
    this.#token = token;
    this.#identity = identity;
    this.#streams = streams;
  }

  static async create(
    root: string,
    token: string,
    identity: { run_id: string; target_sha256: string; profile_digest: string },
    resources: ArtifactResourceScope,
  ): Promise<GhidraDiagnosticExport> {
    const path = mkdtempSync(join(root, "rea-ghidra-"));
    let stdout: RedactedFile | undefined;
    try {
      stdout = await RedactedFile.create(
        join(path, "stdout.log"),
        token,
        resources,
      );
      const stderr = await RedactedFile.create(
        join(path, "stderr.log"),
        token,
        resources,
      );
      return new GhidraDiagnosticExport(path, token, identity, resources, {
        stdout,
        stderr,
      });
    } catch (cause) {
      try {
        if (stdout !== undefined) await stdout.close(false, path);
        else
          await resources.release({
            kind: "lease",
            resource: `Ghidra diagnostic export directory ${path}`,
            lease: {
              release: () => rm(path, { recursive: true, force: true }),
            },
          });
      } catch {
        /* The scope retains the ordered file and directory cleanup. */
      }
      throw cause;
    }
  }
  write(stream: "stdout" | "stderr", chunk: Buffer): void {
    if (this.#finalizing || this.#errors[stream] !== undefined) return;
    try {
      this.#streams[stream].write(chunk);
    } catch (cause) {
      this.#errors[stream] = String(cause);
    }
  }
  async finish(
    paths: { ghidraLogPath: string; scriptLogPath: string } | undefined,
    complete: boolean,
  ): Promise<void> {
    this.#finalizing = true;
    const files: Record<string, FileStatus> = {};
    for (const stream of ["stdout", "stderr"] as const) {
      try {
        await this.#streams[stream].close(
          complete && this.#errors[stream] === undefined,
        );
      } catch (cause) {
        this.#errors[stream] ??= String(cause);
      }
      const reason = this.#errors[stream];
      files[stream] =
        reason === undefined
          ? { status: complete ? "complete" : "incomplete" }
          : { status: "error", reason };
    }
    for (const [name, source] of [
      ["ghidra", paths?.ghidraLogPath],
      ["script", paths?.scriptLogPath],
    ] as const) {
      if (source === undefined) {
        files[name] = { status: "unavailable" };
        continue;
      }
      let input: Awaited<ReturnType<typeof open>> | undefined;
      let output: RedactedFile | undefined;
      try {
        input = await open(source, "r");
        output = await RedactedFile.create(
          join(this.path, `${name}.log`),
          this.#token,
          this.resources,
        );
        // Each await yields the event loop between 64 KiB chunks.
        // ponytail: writes stay synchronous (one chunk each); a queued async
        // writer only if a slow destination is observed.
        const chunk = Buffer.allocUnsafe(64 * 1024);
        let count: number;
        while (
          (count = (await input.read(chunk, 0, chunk.length, null)).bytesRead) >
          0
        )
          output.write(chunk.subarray(0, count));
        const finished = output;
        output = undefined;
        await finished.close(true);
        files[name] = { status: "captured" };
      } catch (cause) {
        try {
          await output?.close(false);
        } catch {
          /* preserve original error */
        }
        const missing =
          (cause as NodeJS.ErrnoException).code === "ENOENT" &&
          input === undefined;
        files[name] = missing
          ? { status: "unavailable" }
          : { status: "error", reason: String(cause) };
      } finally {
        if (input !== undefined) {
          const handle = input;
          const cleanup = await this.resources.release({
            kind: "lease",
            resource: `Ghidra diagnostic source log ${source}`,
            lease: { release: () => handle.close() },
          });
          if (cleanup.kind === "failed") {
            const prior = files[name];
            files[name] = {
              status: "error",
              reason:
                prior?.status === "error"
                  ? `${prior.reason}; source close: ${String(cleanup.cause)}`
                  : String(cleanup.cause),
            };
          }
        }
      }
    }
    const manifest = {
      ...this.#identity,
      files,
      log_source_completeness: "unknown",
    };
    writeFileSync(
      join(this.path, "manifest.json.tmp"),
      JSON.stringify(manifest, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    renameSync(
      join(this.path, "manifest.json.tmp"),
      join(this.path, "manifest.json"),
    );
    if (Object.values(files).some((file) => file.status === "error"))
      throw new Error("Ghidra diagnostic export failed; see manifest.json");
  }
}
