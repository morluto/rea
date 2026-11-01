import {
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/** Redacts an exact ASCII credential even when it crosses input chunks. */
class RedactedFile {
  readonly #fd: number;
  readonly #token: Buffer;
  #tail = Buffer.alloc(0);
  constructor(path: string, token: string) {
    this.#fd = openSync(path, "wx", 0o600);
    this.#token = Buffer.from(token);
  }
  #write(bytes: Buffer): void {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(this.#fd, bytes, offset);
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
  close(complete: boolean): void {
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
    } finally {
      closeSync(this.#fd);
    }
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
  constructor(
    root: string,
    token: string,
    identity: { run_id: string; target_sha256: string; profile_digest: string },
  ) {
    this.path = mkdtempSync(join(root, "rea-ghidra-"));
    this.#token = token;
    this.#identity = identity;
    let stdout: RedactedFile | undefined;
    try {
      stdout = new RedactedFile(join(this.path, "stdout.log"), token);
      this.#streams = {
        stdout,
        stderr: new RedactedFile(join(this.path, "stderr.log"), token),
      };
    } catch (cause) {
      try {
        stdout?.close(false);
      } catch {
        /* preserve allocation failure */
      }
      try {
        rmSync(this.path, { recursive: true });
      } catch {
        /* preserve allocation failure */
      }
      throw cause;
    }
  }
  write(stream: "stdout" | "stderr", chunk: Buffer): void {
    if (this.#errors[stream] !== undefined) return;
    try {
      this.#streams[stream].write(chunk);
    } catch (cause) {
      this.#errors[stream] = String(cause);
    }
  }
  finish(
    paths: { ghidraLogPath: string; scriptLogPath: string } | undefined,
    complete: boolean,
  ): void {
    const files: Record<string, FileStatus> = {};
    for (const stream of ["stdout", "stderr"] as const) {
      try {
        this.#streams[stream].close(
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
      let input: number | undefined;
      let output: RedactedFile | undefined;
      try {
        input = openSync(source, "r");
        output = new RedactedFile(join(this.path, `${name}.log`), this.#token);
        const chunk = Buffer.allocUnsafe(64 * 1024);
        let count: number;
        while ((count = readSync(input, chunk, 0, chunk.length, null)) > 0)
          output.write(chunk.subarray(0, count));
        output.close(true);
        output = undefined;
        files[name] = { status: "captured" };
      } catch (cause) {
        try {
          output?.close(false);
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
        if (input !== undefined) closeSync(input);
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
