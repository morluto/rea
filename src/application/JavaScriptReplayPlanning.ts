import canonicalize from "canonicalize";
import { createHash } from "node:crypto";

import type { JsonValue } from "../domain/jsonValue.js";
import type {
  ControlledReplayInput,
  ReplayExecutionResult,
  ReplayPlan,
} from "../domain/javascriptReplay.js";

const REPLAY_POLICY_VERSION = "linux-bwrap-systemd-v1" as const;
const REPLAY_POLICY_DOCUMENT = Object.freeze({
  version: REPLAY_POLICY_VERSION,
  namespaces: ["user", "pid", "network", "ipc", "uts", "cgroup"],
  capabilities: "drop-all",
  network: "none",
  filesystem: "minimal-read-only-runtime-plus-private-tmpfs",
  seccomp: "rea-linux-x86_64-v1",
  resource_manager: "systemd-user-cgroup-v2",
  nested_user_namespaces: false,
});

export interface ReplaySourceBytes {
  readonly canonicalPath: string;
  readonly bytes: Uint8Array;
}

export interface ReplayExecutableIdentity {
  readonly path: string;
  readonly version: string;
  readonly sha256: string;
}

export interface ReplayRuntimeFileIdentity {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly sha256: string;
}

export interface JavaScriptReplayPolicy {
  readonly enabled: boolean;
  readonly roots: readonly string[];
  readonly nodePath: string;
  readonly bubblewrapPath: string;
  readonly systemdRunPath: string;
  readonly systemctlPath: string;
  readonly shellPath: string;
}

export interface JavaScriptReplayHost {
  readonly readSource: (
    path: string,
    maximumBytes: number,
  ) => Promise<ReplaySourceBytes>;
  readonly identifyExecutable: (
    path: string,
    versionArguments: readonly string[],
  ) => Promise<ReplayExecutableIdentity>;
  readonly identifyWorker: () => Promise<ReplayExecutableIdentity>;
  readonly identifyRuntimeClosure: (
    nodePath: string,
  ) => Promise<readonly ReplayRuntimeFileIdentity[]>;
  readonly seccompDigest: () => string;
  readonly probe: (policy: JavaScriptReplayPolicy) => Promise<void>;
}

export interface PreparedReplayPlan {
  readonly publicPlan: ReplayPlan;
  readonly leftSources: Readonly<Record<string, string>>;
  readonly rightSources?: Readonly<Record<string, string>>;
}

export interface JavaScriptReplayRunner {
  readonly execute: (
    prepared: PreparedReplayPlan,
    policy: JavaScriptReplayPolicy,
    signal?: AbortSignal,
  ) => Promise<ReplayExecutionResult>;
}

/** Read, normalize, and content-address every input to one replay experiment. */
export const prepareReplayPlan = async (
  input: ControlledReplayInput,
  policy: JavaScriptReplayPolicy,
  host: JavaScriptReplayHost,
): Promise<PreparedReplayPlan> => {
  const cases = replayCases(input).map((item) => ({
    ...item,
    sha256: digestJson(item.arguments),
  }));
  if (
    new TextEncoder().encode(
      JSON.stringify(cases.map(({ arguments: args }) => args)),
    ).byteLength > input.limits.input_bytes
  )
    throw new RangeError("Replay case inputs exceed the aggregate byte limit");
  await host.probe(policy);
  const [
    runtime,
    bubblewrap,
    systemdRun,
    systemctl,
    shell,
    worker,
    runtimeFiles,
    left,
    right,
  ] = await Promise.all([
    host.identifyExecutable(policy.nodePath, ["--version"]),
    host.identifyExecutable(policy.bubblewrapPath, ["--version"]),
    host.identifyExecutable(policy.systemdRunPath, ["--version"]),
    host.identifyExecutable(policy.systemctlPath, ["--version"]),
    host.identifyExecutable(policy.shellPath, ["--version"]),
    host.identifyWorker(),
    host.identifyRuntimeClosure(policy.nodePath),
    prepareSide(input.left, input.limits.module_bytes, host),
    input.right === undefined
      ? Promise.resolve(undefined)
      : prepareSide(input.right, input.limits.module_bytes, host),
  ]);
  const withoutDigest = {
    schema_version: 1 as const,
    policy_version: REPLAY_POLICY_VERSION,
    policy_sha256: digestJson(REPLAY_POLICY_DOCUMENT),
    network: "none" as const,
    filesystem: {
      host_writes: false as const,
      private_tmpfs_bytes: input.limits.tmpfs_bytes,
    },
    runtime: {
      executable: runtime,
      worker,
      read_only_files: runtimeFiles.map((item) => ({
        source_path: item.sourcePath,
        destination_path: item.destinationPath,
        sha256: item.sha256,
      })),
    },
    sandbox: {
      bubblewrap,
      systemd_run: systemdRun,
      systemctl,
      shell,
      seccomp_sha256: host.seccompDigest(),
    },
    left: left.commitment,
    ...(right === undefined ? {} : { right: right.commitment }),
    cases,
    determinism: input.determinism,
    limits: input.limits,
    effects: [
      "Execute selected extracted modules in a disposable Linux OS sandbox",
      "Create and remove one private cgroup and mount namespace",
      "Retain bounded return, exception, termination, and diagnostic evidence",
      "Perform no host filesystem writes and expose no host or external network",
      ...(input.reproducer_export === undefined
        ? []
        : ["Write one separately approved reproducer after sandbox cleanup"]),
    ],
    reproducer_export:
      input.reproducer_export === undefined
        ? null
        : {
            path: input.reproducer_export.path,
            include_sources: input.reproducer_export.include_sources,
            authority: "evidence_write" as const,
          },
  };
  const publicPlan: ReplayPlan = {
    ...withoutDigest,
    plan_digest: digestJson(withoutDigest),
  };
  return {
    publicPlan,
    leftSources: left.sources,
    ...(right === undefined ? {} : { rightSources: right.sources }),
  };
};

const prepareSide = async (
  side: ControlledReplayInput["left"],
  maximumBytes: number,
  host: JavaScriptReplayHost,
) => {
  const aliases = new Set(side.modules.map(({ alias }) => alias));
  if (aliases.size !== side.modules.length || !aliases.has(side.entry_alias))
    throw new TypeError("Replay manifest aliases or entry alias are invalid");
  for (const module of side.modules)
    for (const dependency of Object.values(module.dependencies))
      if (!aliases.has(dependency))
        throw new TypeError(
          `Undeclared replay dependency alias: ${dependency}`,
        );
  const loaded: {
    readonly module: (typeof side.modules)[number];
    readonly source: ReplaySourceBytes;
  }[] = [];
  let totalBytes = 0;
  for (const module of side.modules) {
    const remaining = maximumBytes - totalBytes;
    if (remaining <= 0)
      throw new RangeError("Replay module bytes exceed the aggregate limit");
    const source = await host.readSource(module.path, remaining);
    totalBytes += source.bytes.byteLength;
    loaded.push({ module, source });
  }
  return {
    commitment: {
      modules: loaded.map(({ module, source }) => ({
        alias: module.alias,
        canonical_path: source.canonicalPath,
        format: module.format,
        role: module.role,
        byte_count: source.bytes.byteLength,
        sha256: digestBytes(source.bytes),
        dependencies: module.dependencies,
      })),
      entry_alias: side.entry_alias,
      entry_export: side.entry_export,
    },
    sources: Object.fromEntries(
      loaded.map(({ module, source }) => [
        module.alias,
        new TextDecoder("utf-8", { fatal: true }).decode(source.bytes),
      ]),
    ),
  };
};

const replayCases = (
  input: ControlledReplayInput,
): readonly { readonly case_id: string; readonly arguments: JsonValue[] }[] => {
  const explicit = input.cases.map((item) => ({
    case_id: item.case_id,
    arguments: item.arguments,
  }));
  if (input.generator === undefined) return uniqueCases(explicit);
  let state = input.generator.seed || 0x9e37_79b9;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const corpus = boundaryCorpus(input.generator.preset);
  const generated = Array.from(
    { length: input.generator.count },
    (_, index) => ({
      case_id: `generated-${input.generator?.preset ?? "boundary"}-${String(index)}`,
      arguments: [corpus[next() % corpus.length] ?? ""] as JsonValue[],
    }),
  );
  return uniqueCases([...explicit, ...generated]);
};

const uniqueCases = <Case extends { readonly case_id: string }>(
  cases: readonly Case[],
): readonly Case[] => {
  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.case_id))
      throw new TypeError(`Duplicate replay case ID: ${item.case_id}`);
    ids.add(item.case_id);
  }
  return cases;
};

const boundaryCorpus = (
  preset: NonNullable<ControlledReplayInput["generator"]>["preset"],
): readonly JsonValue[] => {
  if (preset === "sanitizer-boundaries")
    return [
      "",
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "javascript:alert(1)",
      "<b>ok</b>",
      "\u0000",
    ];
  if (preset === "clipboard-boundaries")
    return [
      "",
      "plain",
      "a\r\nb",
      "a\nb",
      "\t",
      "😀",
      "text/html",
      "text/plain",
    ];
  return [
    "",
    " ",
    "\n",
    "# heading",
    "**bold**",
    "[x](javascript:y)",
    "`code`",
    "😀",
    "\u0000",
    "a".repeat(1024),
  ];
};

export const digestBytes = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export const digestJson = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Replay commitment is not canonical JSON");
  return createHash("sha256").update(encoded).digest("hex");
};
