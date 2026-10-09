import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Readable } from "node:stream";

import type { ArtifactCommand } from "../domain/artifactGraph.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";
import { DirectoryArtifactReader } from "./DirectoryArtifactReader.js";
import {
  execFileOutput,
  execFileOutputFailure,
} from "../process/ExecFileOutput.js";
import {
  parseNativeDmgAttachOutput,
  parseNativeDmgInfo,
  resolveNativeDmgOwnership,
  type NativeDmgAttachOutput,
  type NativeDmgInfo,
} from "./NativeDmgOwnership.js";
const HDIUTIL_COMMAND_TIMEOUT_MS = 120_000;
// APFS ejects and busy reporting can lag a detach attempt.
const DETACH_SETTLE_DELAYS_MS = [250, 500, 1000] as const;
const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  /** Wait between detach rechecks; tests may resolve immediately. */
  delay?(milliseconds: number): Promise<void>;
}

class NativeDmgCommandFailure extends ArtifactReaderFailure {
  readonly processNotStarted: boolean;

  constructor(
    reason: ArtifactReaderFailure["reason"],
    message: string,
    readonly stdout: string,
    options?: {
      readonly cause?: unknown;
      readonly processNotStarted?: boolean;
    },
  ) {
    super(
      reason,
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.processNotStarted = options?.processNotStarted ?? false;
  }
}

const createSystemHost = (
  environment: Readonly<NodeJS.ProcessEnv>,
): NativeDmgHost => ({
  delay,
  async run(arguments_, signal, options) {
    try {
      const { stdout, stderr } = await execFileOutput(
        "/usr/bin/hdiutil",
        [...arguments_],
        {
          env: environment,
          stopSignal: "SIGTERM",
          ...(options === undefined ? {} : { timeout: options.timeoutMs }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return { stdout, stderr, exitCode: 0 };
    } catch (cause: unknown) {
      const output = execFileOutputFailure(cause);
      if (cause instanceof Error && cause.name === "AbortError")
        throw new NativeDmgCommandFailure(
          "cancelled",
          "DMG operation cancelled",
          output?.stdout ?? "",
          { cause },
        );
      const exitCode =
        typeof output?.code === "number" ? output.code : processExitCode(cause);
      if (exitCode !== undefined)
        return {
          stdout: output?.stdout ?? processOutput(cause, "stdout"),
          stderr: output?.stderr ?? processOutput(cause, "stderr"),
          exitCode,
          cause,
        };
      throw new NativeDmgCommandFailure(
        commandFailureReason(cause, arguments_[0]),
        `hdiutil ${arguments_[0] ?? "operation"} failed: ${describeCommandFailure(cause, arguments_)}`,
        output?.stdout ?? "",
        { cause, processNotStarted: processNotStarted(cause) },
      );
    }
  },
});

/** Read-only macOS DMG adapter that owns attachment and reverse-order detach. */
export class NativeDmgArtifactReader implements ArtifactReader {
  readonly format = "file" as const;
  readonly #provenance: ArtifactCommand[] = [];
  #directory: DirectoryArtifactReader | undefined;
  #devices: string[] = [];
  #inventoryConfirmedDevices = new Set<string>();
  #mountRoot: string | undefined;
  #baselineDevices = new Set<string>();
  #attachOutput: NativeDmgAttachOutput | undefined;
  #attachOutputReturned = false;
  #attachMayHaveMounted = false;
  #ownershipUncertainty: string | undefined;

  private constructor(
    private readonly path: string,
    private readonly host: NativeDmgHost,
  ) {}

  /** Verify and attach one image beneath an exclusively owned temporary root. */
  static async create(
    path: string,
    environment: Readonly<NodeJS.ProcessEnv>,
    signal?: AbortSignal,
    host?: NativeDmgHost,
  ): Promise<NativeDmgArtifactReader> {
    if (process.platform !== "darwin" && host === undefined)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Native DMG traversal is available only on macOS",
      );
    const reader = new NativeDmgArtifactReader(
      path,
      host ?? createSystemHost(environment),
    );
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
    let detachFailure = await this.#reconcileAttachState();
    let remainingDevices: string[] = [];
    for (const device of [...this.#devices].reverse()) {
      const failure = await this.#detach(device);
      if (failure !== undefined) {
        remainingDevices.push(device);
        detachFailure ??= failure;
      }
    }
    // APFS container detach may briefly leave its backing image listed.
    for (const delayMs of DETACH_SETTLE_DELAYS_MS) {
      if (remainingDevices.length === 0) break;
      await (this.host.delay ?? delay)(delayMs);
      const stillAttached: string[] = [];
      for (const device of remainingDevices) {
        if (!(await this.#isAttached(device))) continue;
        const failure = await this.#detach(device);
        if (failure !== undefined) {
          stillAttached.push(device);
          detachFailure = failure;
        }
      }
      remainingDevices = stillAttached;
    }
    if (remainingDevices.length === 0) detachFailure = undefined;
    this.#devices = remainingDevices.reverse();
    if (
      this.#devices.length === 0 &&
      this.#mountRoot !== undefined &&
      !this.#attachMayHaveMounted
    )
      await rm(this.#mountRoot, { recursive: true, force: true }).then(
        () => {
          this.#mountRoot = undefined;
          this.#directory = undefined;
        },
        (cause: unknown) => {
          detachFailure ??= cause;
        },
      );
    if (this.#attachMayHaveMounted) {
      detachFailure ??= new Error(
        this.#ownershipUncertainty ??
          "hdiutil attachment ownership remains unknown",
      );
    }
    if (detachFailure !== undefined)
      throw new ArtifactReaderFailure(
        "unavailable",
        `DMG detach or mount-root cleanup failed for ${JSON.stringify(this.path)}: ${failureMessage(detachFailure)}`,
        {
          cause: detachFailure,
          cleanup: {
            reason: failureMessage(detachFailure),
            resources: [
              ...this.#devices.map((device) => `DMG device ${device}`),
              ...(this.#attachMayHaveMounted
                ? [
                    `DMG attachment ownership unknown at mount root ${this.#mountRoot ?? this.path}`,
                  ]
                : []),
              ...(this.#mountRoot === undefined
                ? []
                : [`DMG mount root ${this.#mountRoot}`]),
            ],
          },
        },
      );
  }

  /** Detach one device; return the failure only while it remains attached. */
  async #detach(device: string): Promise<unknown> {
    try {
      await runChecked(this.host, ["detach", device], undefined, {
        timeoutMs: HDIUTIL_COMMAND_TIMEOUT_MS,
      });
      this.#provenance.push(command(["detach", device], ["mount"]));
      return undefined;
    } catch (cause: unknown) {
      return (await this.#isAttached(device)) ? cause : undefined;
    }
  }

  async #reconcileAttachState(): Promise<unknown> {
    if (!this.#attachMayHaveMounted) return undefined;
    try {
      await this.#resolveAttachOwnership();
      return undefined;
    } catch (cause: unknown) {
      this.#ownershipUncertainty = failureMessage(cause);
      return cause;
    }
  }

  /** Treat unknown hdiutil state as attached during cleanup. */
  async #isAttached(device: string): Promise<boolean> {
    try {
      const parsed = await this.#readInfo();
      const isListed = parsed.images.some((image) =>
        image["system-entities"].some(
          (entity) => entity["dev-entry"] === device,
        ),
      );
      if (isListed) {
        this.#inventoryConfirmedDevices.add(device);
        return true;
      }
      return !this.#inventoryConfirmedDevices.has(device);
    } catch {
      return true;
    }
  }

  async attach(signal?: AbortSignal): Promise<void> {
    await runChecked(this.host, ["verify", this.path], signal);
    this.#provenance.push(command(["verify", this.path], ["read"]));
    const baseline = await this.#readInfo();
    this.#baselineDevices = new Set(
      baseline.images.flatMap((image) =>
        image["system-entities"].map(({ "dev-entry": device }) => device),
      ),
    );
    const mountRoot = await realpath(await mkdtemp(join(tmpdir(), "rea-dmg-")));
    this.#mountRoot = mountRoot;
    try {
      this.#attachMayHaveMounted = true;
      const attached = await runChecked(
        this.host,
        [
          "attach",
          "-readonly",
          "-nobrowse",
          "-plist",
          "-mountroot",
          mountRoot,
          this.path,
        ],
        signal,
        { timeoutMs: HDIUTIL_COMMAND_TIMEOUT_MS },
      );
      this.#attachOutputReturned = true;
      let parsed: NativeDmgAttachOutput;
      try {
        parsed = parseNativeDmgAttachOutput(attached.stdout);
      } catch (cause: unknown) {
        throw new ArtifactReaderFailure(
          "format",
          "hdiutil returned a malformed attachment plist",
          { cause },
        );
      }
      if (parsed["system-entities"].length === 0)
        throw new ArtifactReaderFailure(
          "format",
          "hdiutil returned no attached devices",
        );
      this.#attachOutput = parsed;
      const ownership = await this.#resolveAttachOwnership();
      if (ownership !== "owned")
        throw new ArtifactReaderFailure(
          ownership === "unknown" ? "unavailable" : "path",
          ownership === "unknown"
            ? `DMG attachment ownership is uncertain: ${this.#ownershipUncertainty ?? "no unique mount under the owned root"}`
            : "hdiutil did not mount a new image beneath the owned root",
        );
      this.#provenance.push(
        command(
          [
            "attach",
            "-readonly",
            "-nobrowse",
            "-plist",
            "-mountroot",
            mountRoot,
            this.path,
          ],
          ["read", "mount"],
        ),
      );
      this.#directory = new DirectoryArtifactReader(mountRoot);
    } catch (cause: unknown) {
      if (cause instanceof NativeDmgCommandFailure && cause.stdout !== "") {
        try {
          this.#attachOutput = parseNativeDmgAttachOutput(cause.stdout);
          this.#attachOutputReturned = true;
        } catch {
          // The original command failure remains primary; fresh info still recovers mounts.
        }
      }
      if (cause instanceof NativeDmgCommandFailure && cause.processNotStarted) {
        this.#attachMayHaveMounted = false;
        this.#ownershipUncertainty = undefined;
      }
      let cleanupFailure: unknown;
      try {
        await this.close();
      } catch (cleanupCause: unknown) {
        cleanupFailure = cleanupCause;
      }
      if (cleanupFailure !== undefined)
        throw ArtifactReaderFailure.withCleanup(
          cause,
          ArtifactReaderFailure.cleanupObservation(
            cleanupFailure,
            `DMG mount root ${this.#mountRoot ?? this.path}`,
          ),
        );
      throw cause;
    }
  }

  async #readInfo(): Promise<NativeDmgInfo> {
    const info = await runChecked(this.host, ["info", "-plist"], undefined, {
      timeoutMs: HDIUTIL_COMMAND_TIMEOUT_MS,
    });
    return parseNativeDmgInfo(info.stdout);
  }

  async #resolveAttachOwnership(): Promise<"owned" | "none" | "unknown"> {
    const mountRoot = this.#mountRoot;
    if (mountRoot === undefined)
      throw new Error("DMG mount root is unavailable for ownership discovery");
    const ownership = resolveNativeDmgOwnership({
      info: await this.#readInfo(),
      ...(this.#attachOutput === undefined
        ? {}
        : { attachOutput: this.#attachOutput }),
      attachOutputReturned: this.#attachOutputReturned,
      mountRoot,
      baselineDevices: this.#baselineDevices,
    });
    if (ownership.status === "owned") {
      this.#devices = [...ownership.devices];
      if (ownership.source === "info")
        for (const device of ownership.devices)
          this.#inventoryConfirmedDevices.add(device);
      this.#attachMayHaveMounted = false;
      this.#ownershipUncertainty = undefined;
      return "owned";
    }
    if (ownership.status === "unknown") {
      this.#ownershipUncertainty = ownership.reason;
      return "unknown";
    }
    this.#attachMayHaveMounted = false;
    this.#ownershipUncertainty = undefined;
    this.#devices = [];
    return "none";
  }
}

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const processNotStarted = (cause: unknown): boolean => {
  if (!(cause instanceof Error)) return false;
  const syscall = Reflect.get(cause, "syscall");
  const code = Reflect.get(cause, "code");
  const errno = Reflect.get(cause, "errno");
  return (
    typeof syscall === "string" &&
    syscall.startsWith("spawn ") &&
    (typeof code === "string" ||
      typeof code === "number" ||
      typeof errno === "number")
  );
};

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
      throw new NativeDmgCommandFailure(
        "cancelled",
        "DMG operation cancelled",
        execFileOutputFailure(cause)?.stdout ?? "",
        { cause },
      );
    const output = execFileOutputFailure(cause);
    throw new NativeDmgCommandFailure(
      commandFailureReason(cause, arguments_[0]),
      `hdiutil ${arguments_[0] ?? "operation"} failed: ${describeCommandFailure(
        cause,
        arguments_,
      )}`,
      output?.stdout ?? "",
      { cause, processNotStarted: processNotStarted(cause) },
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
    throw new NativeDmgCommandFailure(
      reason,
      unknownVerifyFailure
        ? `hdiutil verify failed; captured diagnostics do not establish the failure cause: ${details}`
        : `hdiutil ${arguments_[0] ?? "operation"} failed: ${details}`,
      result.stdout,
      { cause: result.cause ?? failure },
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
