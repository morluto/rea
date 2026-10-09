import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, normalize } from "node:path";
import type { BinaryTarget } from "../domain/binaryTarget.js";
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
  private constructor(
    private readonly runtime: PrivateRuntimeRoot,
    readonly inputPath: string,
    private readonly target: BinaryTarget,
  ) {}

  /** Filesystem root owned exclusively by this headless session. */
  get directory(): string {
    return this.runtime.path;
  }

  /** Allocate a protected workspace so its owner can retain it before input preparation. */
  static async allocate(
    target: BinaryTarget,
    root = tmpdir(),
  ): Promise<IdaWorkspace> {
    const runtime = await PrivateRuntimeRoot.create({
      parent: normalize(root),
      prefix: "rea-ida-",
    });
    const inputPath = join(runtime.path, basename(target.path));
    return new IdaWorkspace(runtime, inputPath, target);
  }

  /** Copy and verify admitted bytes after the session owns this workspace's cleanup. */
  async copyInput(): Promise<void> {
    await copyFile(this.target.path, this.inputPath, constants.COPYFILE_EXCL);
    if ((await idaFileDigest(this.inputPath)) !== this.target.sha256)
      throw new AnalysisProtocolError(
        "IDA target changed between admission and the private input copy; reopen the target.",
      );
  }

  /** Delete only this object's privately allocated directory after worker cleanup. */
  async remove(): Promise<void> {
    await this.runtime.close();
  }
}
