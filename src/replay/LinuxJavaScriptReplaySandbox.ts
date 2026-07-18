import { open } from "node:fs/promises";
import { dirname } from "node:path";

import {
  digestJson,
  type JavaScriptReplayPolicy,
  type PreparedReplayPlan,
} from "../application/JavaScriptReplayPlanning.js";
import { buildLinuxX64ReplaySeccomp } from "./LinuxSeccompPolicy.js";
import { resolveLinuxRuntimeClosure } from "./LinuxRuntimeClosure.js";

export type RuntimeFile = Awaited<
  ReturnType<typeof resolveLinuxRuntimeClosure>
>[number];

export interface SandboxArgumentsOptions {
  readonly unit: string;
  readonly policy: JavaScriptReplayPolicy;
  readonly prepared: PreparedReplayPlan;
  readonly workerPath: string;
  readonly closure: readonly RuntimeFile[];
  readonly filterPath: string;
}

export const assertRuntimeCommitment = (
  prepared: PreparedReplayPlan,
  closure: readonly RuntimeFile[],
): void => {
  const observed = closure.map((item) => ({
    source_path: item.sourcePath,
    destination_path: item.destinationPath,
    sha256: item.sha256,
  }));
  if (
    digestJson(observed) !==
    digestJson(prepared.publicPlan.runtime.read_only_files)
  )
    throw new TypeError("Replay runtime closure changed after approval");
};

export const temporaryFilterHandle = async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "rea-replay-filter-"));
  const path = join(directory, "seccomp.bpf");
  await writeFile(path, buildLinuxX64ReplaySeccomp(), { mode: 0o600 });
  const handle = await open(path, "r");
  return {
    path,
    handle,
    close: async () => {
      await handle.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
};

export const systemdArguments = (
  options: SandboxArgumentsOptions,
): string[] => {
  const { unit, policy, prepared, workerPath, closure, filterPath } = options;
  const limits = prepared.publicPlan.limits;
  const descriptorPaths = [
    filterPath,
    ...closure.map(({ sourcePath }) => sourcePath),
    workerPath,
  ];
  const workerFd = descriptorPaths.length + 2;
  const wrapper = descriptorPaths
    .map((_, index) => `exec ${String(index + 3)}<"$1"; shift`)
    .concat('exec "$@"')
    .join("\n");
  return [
    "--user",
    "--pipe",
    "--wait",
    "--service-type=exec",
    "--quiet",
    `--unit=${unit}`,
    `--property=MemoryMax=${String(limits.memory_bytes)}`,
    "--property=MemorySwapMax=0",
    `--property=TasksMax=${String(limits.tasks)}`,
    `--property=CPUQuota=${String(limits.cpu_quota_percent)}%`,
    "--property=KillMode=control-group",
    "--property=SendSIGKILL=yes",
    "--",
    policy.shellPath,
    "-c",
    wrapper,
    "rea-replay-wrapper",
    ...descriptorPaths,
    policy.bubblewrapPath,
    "--unshare-all",
    "--unshare-user",
    "--disable-userns",
    "--new-session",
    "--die-with-parent",
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--setenv",
    "HOME",
    "/work",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "TZ",
    "UTC",
    "--setenv",
    "LANG",
    "C",
    "--setenv",
    "LC_ALL",
    "C",
    "--tmpfs",
    "/",
    "--dir",
    "/runtime",
    "--dir",
    "/work",
    "--size",
    String(limits.tmpfs_bytes),
    "--tmpfs",
    "/tmp",
    ...bindArguments(closure),
    "--ro-bind-fd",
    String(workerFd),
    "/runtime/worker.js",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--remount-ro",
    "/",
    "--chdir",
    "/work",
    "--seccomp",
    "3",
    "--",
    "/runtime/node",
    `--max-old-space-size=${String(
      Math.max(8, Math.floor(limits.memory_bytes / 1024 / 1024 / 2)),
    )}`,
    "--experimental-vm-modules",
    "--permission",
    "--allow-fs-read=/runtime/worker.js",
    "/runtime/worker.js",
  ];
};

const bindArguments = (closure: readonly RuntimeFile[]): string[] => {
  const arguments_: string[] = [];
  const directories = new Set<string>();
  for (const [index, item] of closure.entries()) {
    const destination = item.destinationPath;
    let parent = dirname(destination);
    const chain: string[] = [];
    while (parent !== "/" && !directories.has(parent)) {
      chain.push(parent);
      parent = dirname(parent);
    }
    for (const directory of chain.reverse()) {
      directories.add(directory);
      arguments_.push("--dir", directory);
    }
    arguments_.push("--ro-bind-fd", String(index + 4), destination);
  }
  return arguments_;
};
