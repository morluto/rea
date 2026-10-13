import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, normalize } from "node:path";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";

/** Read a file digest with bounded memory rather than retaining binary bytes. */
export const idaFileDigest = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

/** Compare host-local paths without confusing Windows paths with POSIX coordinates. */
export const sameIdaHostPath = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);

/** Private input copy isolates upstream database and sidecar writes from the original. */
export class IdaWorkspace {
  readonly sessionId = `rea-${randomUUID()}`;
  #inputSha256: string | undefined;
  private constructor(
    private readonly runtime: PrivateRuntimeRoot,
    readonly inputPath: string,
    private readonly target: BinaryTarget,
  ) {}

  /** Filesystem root owned exclusively by this headless session. */
  get directory(): string {
    return this.runtime.path;
  }

  /** SHA-256 of the private input bytes copyInput admitted; undefined until prepared. */
  get inputSha256(): string | undefined {
    return this.#inputSha256;
  }

  /** Allocate a protected workspace so its owner can retain it before input preparation. */
  static async allocate(
    target: BinaryTarget,
    root = tmpdir(),
  ): Promise<IdaWorkspace> {
    // Upstream reports canonical paths (macOS /var -> /private/var), so the
    // private input path must already be canonical for identity checks.
    const runtime = await PrivateRuntimeRoot.create({
      parent: await realpath(normalize(root)),
      prefix: "rea-ida-",
    });
    const inputPath = join(runtime.path, basename(target.path));
    return new IdaWorkspace(runtime, inputPath, target);
  }

  /**
   * Copy and verify admitted bytes after the session owns this workspace's
   * cleanup. Universal Mach-O containers are thinned to the selected slice so
   * the upstream engine analyzes the architecture admission reported; the
   * whole-source digest still anchors the copy against admission-time changes.
   */
  async copyInput(): Promise<void> {
    const slice =
      this.target.format === "mach-o-universal"
        ? this.target.universalSlice
        : undefined;
    const source = await open(this.target.path, "r");
    try {
      const input = await open(this.inputPath, "wx");
      try {
        const sourceHash = createHash("sha256");
        const inputHash = createHash("sha256");
        const chunk = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        for (;;) {
          const observed = await source.read(chunk, 0, chunk.length, position);
          if (observed.bytesRead === 0) break;
          const bytes = chunk.subarray(0, observed.bytesRead);
          sourceHash.update(bytes);
          const start =
            slice === undefined ? position : Math.max(position, slice.offset);
          const end =
            slice === undefined
              ? position + bytes.length
              : Math.min(position + bytes.length, slice.offset + slice.size);
          // A chunk after the slice has end < position, and a negative subarray
          // bound would count from the chunk's end instead of being empty.
          if (end > start) {
            const admitted = bytes.subarray(start - position, end - position);
            inputHash.update(admitted);
            await input.write(admitted);
          }
          position += observed.bytesRead;
        }
        if (sourceHash.digest("hex") !== this.target.sha256)
          throw new AnalysisProtocolError(
            "IDA target changed between admission and the private input copy; reopen the target.",
          );
        this.#inputSha256 = inputHash.digest("hex");
      } finally {
        await input.close();
      }
    } finally {
      await source.close();
    }
  }

  /** Delete only this object's privately allocated directory after worker cleanup. */
  async remove(): Promise<void> {
    await this.runtime.close();
  }
}
