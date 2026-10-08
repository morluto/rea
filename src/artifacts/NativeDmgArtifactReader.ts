import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { Readable } from "node:stream";

import { parse } from "plist";
import { z } from "zod";

import type { ArtifactCommand } from "../domain/artifactGraph.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";
import { DirectoryArtifactReader } from "./DirectoryArtifactReader.js";
import { execFileOutput } from "../process/ExecFileOutput.js";
const DETACH_TIMEOUT_MS = 120_000;
const attachOutputSchema = z.object({
  "system-entities": z.array(
    z.object({
      "dev-entry": z.string().startsWith("/dev/"),
      "mount-point": z.string().optional(),
    }),
  ),
});
const infoOutputSchema = z.object({
  images: z.array(
    z.object({
      "system-entities": z.array(z.object({ "dev-entry": z.string() })),
    }),
  ),
});

/** Narrow host seam for tested, shell-free hdiutil lifecycle operations. */
export interface NativeDmgHost {
  run(
    arguments_: readonly string[],
    signal?: AbortSignal,
    options?: { readonly timeoutMs: number },
  ): Promise<{
    readonly stdout: string;
    readonly stderr?: string;
    readonly exitCode: number;
    readonly cause?: unknown;
  }>;
}

const systemHost: NativeDmgHost = {
  async run(arguments_, signal, options) {
    try {
      const { stdout, stderr } = await execFileOutput(
        "/usr/bin/hdiutil",
        [...arguments_],
        {
          ...(options === undefined ? {} : { timeout: options.timeoutMs }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return { stdout, stderr, exitCode: 0 };
    } catch (cause: unknown) {
      if (cause instanceof Error && cause.name === "AbortError")
        throw new ArtifactReaderFailure("cancelled", "DMG operation cancelled");
      const exitCode = processExitCode(cause);
      if (exitCode !== undefined)
        return {
          stdout: processOutput(cause, "stdout"),
          stderr: processOutput(cause, "stderr"),
          exitCode,
          cause,
        };
      throw new ArtifactReaderFailure(
        commandFailureReason(cause, arguments_[0]),
        `hdiutil ${arguments_[0] ?? "operation"} failed: ${describeCommandFailure(cause, arguments_)}`,
        { cause },
      );
    }
  },
};

/** Read-only macOS DMG adapter that owns attachment and reverse-order detach. */
export class NativeDmgArtifactReader implements ArtifactReader {
  readonly format = "file" as const;
  readonly #provenance: ArtifactCommand[] = [];
  #directory: DirectoryArtifactReader | undefined;
  #devices: string[] = [];
  #mountRoot: string | undefined;

  private constructor(
    private readonly path: string,
    private readonly host: NativeDmgHost,
  ) {}

  /** Verify and attach one image beneath an exclusively owned temporary root. */
  static async create(
    path: string,
    signal?: AbortSignal,
    host: NativeDmgHost = systemHost,
  ): Promise<NativeDmgArtifactReader> {
    if (process.platform !== "darwin" && host === systemHost)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Native DMG traversal is available only on macOS",
      );
    const reader = new NativeDmgArtifactReader(path, host);
    await reader.attach(signal);
    return reader;
  }

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    if (this.#directory === undefined)
      throw new ArtifactReaderFailure("unavailable", "DMG is not attached");
    const prefix = basename(this.path);
    for await (const entry of this.#directory.entries(signal))
      yield { ...entry, path: `${prefix}/${entry.path}` };
  }

  open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    if (this.#directory === undefined)
      return Promise.reject(
        new ArtifactReaderFailure("unavailable", "DMG is not attached"),
      );
    return this.#directory.open(entry, signal);
  }

  provenance(): readonly ArtifactCommand[] {
    return structuredClone(this.#provenance);
  }

  async close(): Promise<void> {
    let detachFailure: unknown;
    for (const device of [...this.#devices].reverse()) {
      try {
        await runChecked(this.host, ["detach", device], undefined, {
          timeoutMs: DETACH_TIMEOUT_MS,
        });
        this.#provenance.push(command(["detach", device], ["mount"]));
      } catch (cause: unknown) {
        // Detaching a synthesized APFS container also ejects the image that
        // backs it, so a later whole disk of the same image may already be
        // gone. Only a device that is still attached is a cleanup failure.
        if (await this.#isAttached(device)) detachFailure ??= cause;
      }
    }
    this.#devices = [];
    if (this.#mountRoot !== undefined)
      await rm(this.#mountRoot, { recursive: true, force: true }).catch(
        (cause: unknown) => {
          detachFailure ??= cause;
        },
      );
    if (detachFailure !== undefined)
      throw new ArtifactReaderFailure(
        "unavailable",
        "DMG detach or mount-root cleanup failed",
        { cause: detachFailure },
      );
  }

  /**
   * Report whether hdiutil still lists a device; unknown state counts as
   * attached. Like detach, this cleanup query runs after the inventory
   * snapshot has captured provenance, so it is not recorded there.
   */
  async #isAttached(device: string): Promise<boolean> {
    try {
      const info = await runChecked(this.host, ["info", "-plist"], undefined, {
        timeoutMs: DETACH_TIMEOUT_MS,
      });
      const parsed = infoOutputSchema.parse(parse(info.stdout));
      return parsed.images.some((image) =>
        image["system-entities"].some(
          (entity) => entity["dev-entry"] === device,
        ),
      );
    } catch {
      return true;
    }
  }

  async attach(signal?: AbortSignal): Promise<void> {
    await runChecked(this.host, ["verify", this.path], signal);
    this.#provenance.push(command(["verify", this.path], ["read"]));
    this.#mountRoot = await realpath(await mkdtemp(join(tmpdir(), "rea-dmg-")));
    try {
      const attached = await runChecked(
        this.host,
        [
          "attach",
          "-readonly",
          "-nobrowse",
          "-plist",
          "-mountroot",
          this.#mountRoot,
          this.path,
        ],
        signal,
      );
      const parsed = attachOutputSchema.parse(parse(attached.stdout));
      const devices = [
        ...new Set(
          parsed["system-entities"].map((entity) => entity["dev-entry"]),
        ),
      ];
      // Detaching an observed whole disk also detaches its partitions. Do not
      // subsequently detach the now-unavailable child devices.
      this.#devices = devices.filter(
        (device) =>
          !devices.some(
            (parent) =>
              /^\/dev\/disk\d+$/u.test(parent) &&
              device.startsWith(`${parent}s`) &&
              /^\d+$/u.test(device.slice(parent.length + 1)),
          ),
      );
      if (this.#devices.length === 0)
        throw new ArtifactReaderFailure(
          "format",
          "hdiutil returned no attached devices",
        );
      for (const entity of parsed["system-entities"]) {
        if (entity["mount-point"] === undefined) continue;
        const contained = relative(this.#mountRoot, entity["mount-point"]);
        if (
          contained === "" ||
          contained === ".." ||
          contained.startsWith(`..${sep}`) ||
          isAbsolute(contained)
        )
          throw new ArtifactReaderFailure(
            "path",
            "hdiutil mounted outside the owned root",
          );
      }
      this.#provenance.push(
        command(
          [
            "attach",
            "-readonly",
            "-nobrowse",
            "-plist",
            "-mountroot",
            this.#mountRoot,
            this.path,
          ],
          ["read", "mount"],
        ),
      );
      this.#directory = new DirectoryArtifactReader(this.#mountRoot);
    } catch (cause: unknown) {
      let cleanupFailure: unknown;
      try {
        await this.close();
      } catch (cleanupCause: unknown) {
        cleanupFailure = cleanupCause;
      }
      if (cleanupFailure !== undefined)
        throw new ArtifactReaderFailure(
          "unavailable",
          "DMG attach failed and cleanup could not detach every device",
          { cause: new AggregateError([cause, cleanupFailure]) },
        );
      throw cause;
    }
  }
}

const runChecked = async (
  host: NativeDmgHost,
  arguments_: readonly string[],
  signal?: AbortSignal,
  options?: { readonly timeoutMs: number },
): Promise<{ readonly stdout: string; readonly exitCode: 0 }> => {
  let result: Awaited<ReturnType<NativeDmgHost["run"]>>;
  try {
    result = await host.run(arguments_, signal, options);
  } catch (cause: unknown) {
    if (cause instanceof ArtifactReaderFailure) throw cause;
    if (cause instanceof Error && cause.name === "AbortError")
      throw new ArtifactReaderFailure("cancelled", "DMG operation cancelled", {
        cause,
      });
    throw new ArtifactReaderFailure(
      commandFailureReason(cause, arguments_[0]),
      `hdiutil ${arguments_[0] ?? "operation"} failed: ${describeCommandFailure(
        cause,
        arguments_,
      )}`,
      { cause },
    );
  }
  if (result.exitCode !== 0) {
    const failure = {
      command: "/usr/bin/hdiutil",
      exitCode: result.exitCode,
      ...(result.cause === undefined
        ? {}
        : { code: processExitCode(result.cause) }),
      stdout: result.stdout,
      ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
    };
    const reason = commandFailureReason(failure, arguments_[0]);
    const details = describeCommandFailure(failure, arguments_);
    const unknownVerifyFailure =
      arguments_[0] === "verify" && reason === "unavailable";
    throw new ArtifactReaderFailure(
      reason,
      unknownVerifyFailure
        ? `hdiutil verify failed; captured diagnostics do not establish the failure cause: ${details}`
        : `hdiutil ${arguments_[0] ?? "operation"} failed: ${details}`,
      result.cause === undefined ? undefined : { cause: result.cause },
    );
  }
  return { stdout: result.stdout, exitCode: 0 };
};

const describeCommandFailure = (
  cause: unknown,
  arguments_: readonly string[],
): string => {
  const fields: Record<string, string | number | readonly string[]> = {
    command: "/usr/bin/hdiutil",
    arguments: [...arguments_],
  };
  if (typeof cause === "object" && cause !== null) {
    for (const key of [
      "code",
      "exitCode",
      "errno",
      "syscall",
      "signal",
      "stdout",
      "stderr",
    ] as const) {
      const value = Reflect.get(cause, key);
      if (typeof value === "string" || typeof value === "number")
        fields[key] = value;
    }
    const code = Reflect.get(cause, "code");
    if (typeof code === "number") fields.exitCode = code;
  }
  if (cause instanceof ArtifactReaderFailure) fields.message = cause.message;
  else if (cause instanceof Error) fields.message = cause.message;
  return JSON.stringify(fields);
};

const processExitCode = (cause: unknown): number | undefined => {
  if (typeof cause !== "object" || cause === null) return undefined;
  const exitCode = Reflect.get(cause, "exitCode");
  if (typeof exitCode === "number") return exitCode;
  const code = Reflect.get(cause, "code");
  return typeof code === "number" ? code : undefined;
};

const processOutput = (cause: unknown, field: "stdout" | "stderr"): string => {
  if (typeof cause !== "object" || cause === null) return "";
  const value = Reflect.get(cause, field);
  return typeof value === "string" ? value : "";
};

const commandFailureReason = (
  cause: unknown,
  operation: string | undefined,
): ArtifactReaderFailure["reason"] => {
  if (typeof cause !== "object" || cause === null) return "unavailable";
  const code = Reflect.get(cause, "code");
  const exitCode = Reflect.get(cause, "exitCode");
  if (typeof code === "number" || typeof exitCode === "number")
    return operation === "verify" ? verifyFailureReason(cause) : "unavailable";
  if (code === "ENOENT") {
    const syscall = Reflect.get(cause, "syscall");
    return typeof syscall === "string" && syscall.startsWith("spawn")
      ? "unavailable"
      : "io";
  }
  if (
    code === "EACCES" ||
    code === "EPERM" ||
    code === "EIO" ||
    code === "ENOTDIR" ||
    code === "EISDIR" ||
    code === "ENODEV" ||
    code === "EROFS" ||
    code === "EMFILE" ||
    code === "ENFILE"
  )
    return "io";
  return "unavailable";
};

const verifyFailureReason = (
  cause: unknown,
): ArtifactReaderFailure["reason"] => {
  const diagnostic = verifyFailureDiagnostic(
    processOutput(cause, "stdout"),
    processOutput(cause, "stderr"),
  );
  switch (diagnostic) {
    case "image not recognized":
      return "format";
    case "invalid checksum":
    case "image data corrupted":
      return "integrity";
    case "No such file or directory":
    case "Permission denied":
    case "Input/output error":
      return "io";
    default:
      return "unavailable";
  }
};

const verifyFailureDiagnostic = (
  stdout: string,
  stderr: string,
): string | undefined => {
  const prefix = "hdiutil: verify failed - ";
  return `${stdout}\n${stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length);
};

const command = (
  arguments_: readonly string[],
  effects: ArtifactCommand["effects"],
): ArtifactCommand => ({
  tool: "/usr/bin/hdiutil",
  arguments: [...arguments_],
  tool_version: null,
  executable_sha256: null,
  exit_code: 0,
  effects,
});
