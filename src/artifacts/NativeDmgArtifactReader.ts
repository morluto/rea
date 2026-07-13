import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

import { parse } from "plist";
import { z } from "zod";

import type { ArtifactCommand } from "../domain/artifactGraph.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";
import { DirectoryArtifactReader } from "./DirectoryArtifactReader.js";

const execFileAsync = promisify(execFile);
const attachOutputSchema = z.object({
  "system-entities": z.array(
    z.object({
      "dev-entry": z.string().startsWith("/dev/"),
      "mount-point": z.string().optional(),
    }),
  ),
});

/** Narrow host seam for tested, shell-free hdiutil lifecycle operations. */
export interface NativeDmgHost {
  run(
    arguments_: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ readonly stdout: string; readonly exitCode: number }>;
}

const systemHost: NativeDmgHost = {
  async run(arguments_, signal) {
    try {
      const { stdout } = await execFileAsync(
        "/usr/bin/hdiutil",
        [...arguments_],
        {
          encoding: "utf8",
          timeout: 120_000,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return { stdout, exitCode: 0 };
    } catch (cause: unknown) {
      if (cause instanceof Error && cause.name === "AbortError")
        throw new ArtifactReaderFailure("cancelled", "DMG operation cancelled");
      throw new ArtifactReaderFailure("format", "hdiutil rejected the DMG", {
        cause,
      });
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
    if (process.platform !== "darwin")
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
    return this.#provenance;
  }

  async close(): Promise<void> {
    let detachFailure: unknown;
    for (const device of [...this.#devices].reverse()) {
      try {
        await runChecked(this.host, ["detach", device]);
        this.#provenance.push(command(["detach", device], ["mount"]));
      } catch (cause: unknown) {
        detachFailure ??= cause;
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

  async attach(signal?: AbortSignal): Promise<void> {
    await runChecked(this.host, ["verify", this.path], signal);
    this.#provenance.push(command(["verify", this.path], ["read"]));
    this.#mountRoot = await mkdtemp(join(tmpdir(), "rea-dmg-"));
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
      this.#devices = parsed["system-entities"].map(
        (entity) => entity["dev-entry"],
      );
      if (this.#devices.length === 0)
        throw new ArtifactReaderFailure(
          "format",
          "hdiutil returned no attached devices",
        );
      for (const entity of parsed["system-entities"])
        if (
          entity["mount-point"] !== undefined &&
          !entity["mount-point"].startsWith(`${this.#mountRoot}/`)
        )
          throw new ArtifactReaderFailure(
            "path",
            "hdiutil mounted outside the owned root",
          );
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
): Promise<{ readonly stdout: string; readonly exitCode: 0 }> => {
  const result = await host.run(arguments_, signal);
  if (result.exitCode !== 0)
    throw new ArtifactReaderFailure(
      "unavailable",
      `hdiutil ${arguments_[0] ?? "operation"} failed with a non-zero exit code`,
    );
  return { stdout: result.stdout, exitCode: 0 };
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
