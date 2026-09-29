import { temporaryFilterHandle } from "./ReplaySeccompFile.js";
import { constants } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn, type StdioOptions } from "node:child_process";

import type {
  JavaScriptReplayHost,
  EnabledJavaScriptReplayPolicy,
  ReplayExecutableIdentity,
  ReplaySourceBytes,
} from "../application/JavaScriptReplayPlanning.js";
import { digestBytes } from "../application/JavaScriptReplayPlanning.js";
import { linuxX64ReplaySeccompDigest } from "./LinuxSeccompPolicy.js";
import { resolveLinuxRuntimeClosure } from "./LinuxRuntimeClosure.js";

import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";

const bubblewrapProbeArguments = (command: readonly string[]): string[] => [
  "--unshare-all",
  "--unshare-user",
  "--disable-userns",
  "--new-session",
  "--die-with-parent",
  "--cap-drop",
  "ALL",
  "--ro-bind",
  "/usr",
  "/usr",
  "--ro-bind",
  "/lib",
  "/lib",
  "--ro-bind-try",
  "/lib64",
  "/lib64",
  "--proc",
  "/proc",
  "--dev",
  "/dev",
  "--seccomp",
  "3",
  "--",
  ...command,
];

/** Production planning host for descriptor-backed reads and fail-closed probes. */
export class SystemJavaScriptReplayHost implements JavaScriptReplayHost {
  async readSource(
    path: string,
    maximumBytes: number,
  ): Promise<ReplaySourceBytes> {
    const canonicalPath = await realpath(path);
    const handle = await open(
      canonicalPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > maximumBytes)
        throw new RangeError(
          `Replay source exceeds its declared limit: ${canonicalPath}`,
        );
      const bytes = await readBoundedFileBytes(handle, maximumBytes);
      if (bytes === undefined)
        throw new RangeError(
          `Replay source exceeds its declared limit: ${canonicalPath}`,
        );
      return { canonicalPath, bytes };
    } finally {
      await handle.close();
    }
  }

  async identifyExecutable(
    path: string,
    versionArguments: readonly string[],
  ): Promise<ReplayExecutableIdentity> {
    const canonicalPath = await realpath(path);
    const metadata = await stat(canonicalPath);
    if (!metadata.isFile())
      throw new TypeError(`Replay executable is not a file: ${canonicalPath}`);
    const [bytes, version] = await Promise.all([
      readFile(canonicalPath),
      capture(canonicalPath, versionArguments),
    ]);
    return {
      path: canonicalPath,
      version: version.trim(),
      sha256: digestBytes(bytes),
    };
  }

  identifyWorker(): Promise<ReplayExecutableIdentity> {
    return this.identifyExecutable(
      fileURLToPath(new URL("./JavaScriptReplayWorker.js", import.meta.url)),
      [],
    );
  }

  identifyRuntimeClosure(nodePath: string) {
    return resolveLinuxRuntimeClosure(nodePath);
  }

  seccompDigest(): string {
    return linuxX64ReplaySeccompDigest();
  }

  async probe(policy: EnabledJavaScriptReplayPolicy): Promise<void> {
    if (process.platform !== "linux" || process.arch !== "x64")
      throw new TypeError("Controlled replay requires Linux x86_64 in v1");
    const bwrapMetadata = await stat(policy.bubblewrapPath);
    if ((bwrapMetadata.mode & 0o4000) !== 0)
      throw new TypeError("Setuid Bubblewrap is not admitted by replay policy");
    if (
      (await readFile("/sys/fs/cgroup/cgroup.controllers", "utf8")).trim()
        .length === 0
    )
      throw new TypeError("Controlled replay requires delegated cgroup v2");
    const filter = await temporaryFilterHandle();
    try {
      await run(
        policy.bubblewrapPath,
        bubblewrapProbeArguments(["/usr/bin/true"]),
        ["ignore", "pipe", "pipe", filter.handle.fd],
      );
      await runExpectFailure(
        policy.bubblewrapPath,
        bubblewrapProbeArguments([
          "/usr/bin/unshare",
          "--mount",
          "/usr/bin/true",
        ]),
        ["ignore", "pipe", "pipe", filter.handle.fd],
      );
      await run(policy.systemdRunPath, [
        "--user",
        "--pipe",
        "--wait",
        "--service-type=exec",
        "--quiet",
        "--property=MemoryMax=16777216",
        "--property=MemorySwapMax=0",
        "--property=TasksMax=2",
        "--",
        "/usr/bin/true",
      ]);
    } finally {
      await filter.close();
    }
  }
}

const capture = async (
  executable: string,
  arguments_: readonly string[],
): Promise<string> => {
  if (arguments_.length === 0) return "content-addressed-worker-v1";
  const result = await collect(executable, arguments_);
  if (result.code !== 0)
    throw new TypeError(`Replay executable probe failed: ${executable}`);
  return result.stdout.length > 0 ? result.stdout : result.stderr;
};

const run = async (
  executable: string,
  arguments_: readonly string[],
  stdio?: StdioOptions,
): Promise<void> => {
  const result = await collect(executable, arguments_, stdio);
  if (result.code !== 0)
    throw new TypeError(
      `Replay feature probe failed (${String(result.code)}): ${executable}: ${result.stderr.trim()}`,
    );
};

const runExpectFailure = async (
  executable: string,
  arguments_: readonly string[],
  stdio: StdioOptions,
): Promise<void> => {
  const result = await collect(executable, arguments_, stdio);
  if (result.code === 0)
    throw new TypeError(
      `Replay denial probe unexpectedly succeeded: ${executable}`,
    );
};

const collect = async (
  executable: string,
  arguments_: readonly string[],
  stdio: StdioOptions = ["ignore", "pipe", "pipe"],
): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], { stdio });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    timeout.unref();
    let stdout = "";
    let stderr = "";
    if (child.stdout !== null)
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
    if (child.stderr !== null)
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
