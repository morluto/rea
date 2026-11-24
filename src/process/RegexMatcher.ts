import { readRuntimeSetting } from "../config/runtimeAnalysisSettings.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { analysisSettingLimit } from "../domain/analysisSettingDefinitions.js";
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";

import { isRecord } from "../kernel/isRecord.js";
import { errorMessage } from "../kernel/errorMessage.js";

import type {
  AnalysisError,
  AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  DEFAULT_REGEX_MATCHING_DEADLINE,
  REGEX_MATCHING_DEADLINE_SETTING,
  regexMatchingDeadlineContinuingRecovery,
  regexMatchingDeadlineRecovery,
  type RegexMatchingDeadline,
} from "../config/regexMatchingDeadline.js";
import {
  DEFAULT_REGEX_WORKER_HEAP_REQUEST,
  REGEX_WORKER_HEAP_REQUEST_SETTING,
  regexWorkerHeapRequestContinuingRecovery,
  regexWorkerHeapRequestRecovery,
  type RegexWorkerHeapRequest,
} from "../config/regexWorkerHeapRequest.js";
import { decodeStrictUtf8, strictUtf8Decoder } from "../domain/strictUtf8.js";
/**
 * Node's Worker `resourceLimits.maxOldGenerationSizeMb` request.
 * `REA_REGEX_WORKER_HEAP_REQUEST_MIB` is that request (default 128 MiB). A positive
 * `--max-old-space-size` on the process that starts REA, including
 * `NODE_OPTIONS`, overrides it. A zero or empty value leaves this request
 * in effect. `NODE_OPTIONS` is applied before `process.execArgv`, and the
 * last absolute flag wins. That environment value is not copied into `execArgv`.
 *
 * `--max-old-space-size-percentage` is applied after both sources and takes
 * precedence over the absolute flag in either order. Node turns it into a MiB
 * from constrained or total memory while parsing options. That base can change
 * before user code reads it, and some Node versions also cap total memory at
 * 4 GiB when pointer compression is on. A later read is not the value Node
 * applied, so a percentage flag leaves the effective heap unestablished
 * instead of the worker heap request or an absolute flag.
 *
 * `process.env.NODE_OPTIONS` is not that launch value. A preload can clear or
 * rewrite it after V8 has already applied the original flags, and those flags
 * are not copied into `process.execArgv`. The launch string is the
 * `NODE_OPTIONS` entry in the process initial environment when that block can
 * be read. Otherwise the effective heap stays unestablished.
 *
 * `process.execArgv` is mutable in the same way. A preload can empty it after
 * V8 has applied `--max-old-space-size`. Linux keeps the original tokens in
 * `/proc/self/cmdline` until `process.title` or `--title` overwrites that
 * same memory with the title. The recovered list skips the executable and the
 * program entry the way Node builds `execArgv`, and it stops at `--`. A
 * buffer without a program entry is not an empty option list. When that block
 * cannot be read, the entry cannot be established, or the platform has no
 * equivalent block, the effective heap stays unestablished. The mutable array
 * is not a fallback.
 *
 * `--max-heap-size` is the total heap, not the old generation. A positive
 * value can be lower than the worker heap request and still changes the result
 * when an old-space flag is also present. The old generation stays
 * unestablished while that value is in effect. Zero or empty clears it.
 * Node 24 and later also accept the flag in `NODE_OPTIONS`.
 *
 * `--experimental-config-file` and `--experimental-default-config-file` can
 * set `nodeOptions`, including a heap percentage, from a file. That file is
 * not launch provenance, and it can add heap options when `NODE_OPTIONS` was
 * already set. Either flag leaves the old generation unestablished. Node
 * accepts the config path as `=` or the next argument. Underscore spellings
 * are not these flags.
 */
const OLD_SPACE_FLAG = /^--max[-_]old[-_]space[-_]size(?:=(.*))?$/u;
const OLD_SPACE_PERCENT_FLAG =
  /^--max[-_]old[-_]space[-_]size[-_]percentage(?:=.*)?$/u;
const MAX_HEAP_FLAG = /^--max[-_]heap[-_]size(?:=(.*))?$/u;
/**
 * Node applies `NODE_OPTIONS` from `--env-file` / `--env-file-if-exists` only
 * when the variable was absent. The file is not in `/proc/self/environ`, and a
 * later read is not the startup contents. Underscore spellings are not this flag.
 */
const ENV_FILE_FLAG = /^--env-file(?:-if-exists)?(?:=.*)?$/u;
/** Path form and the boolean default-file flag. The file itself is not read. */
const CONFIG_FILE_FLAG = /^--experimental-(?:default-)?config-file(?:=.*)?$/u;

/** Old-generation heap the regex worker will actually hit. */
export type RegexWorkerHeapLimit =
  | {
      readonly kind: "effective";
      readonly mib: number;
      /** True when a positive `--max-old-space-size` overrides the worker heap request. */
      readonly overridden: boolean;
    }
  | { readonly kind: "unknown" };

/** Node's `ParseNodeOptionsEnvVar`: quotes group tokens and are not part of them. */
const nodeOptionsArgv = (
  nodeOptions: string,
): readonly string[] | undefined => {
  const argv: string[] = [];
  let inString = false;
  let startNew = true;
  for (let index = 0; index < nodeOptions.length; index += 1) {
    let character = nodeOptions.charAt(index);
    if (character === "\\" && inString) {
      if (index + 1 >= nodeOptions.length) return undefined;
      index += 1;
      character = nodeOptions.charAt(index);
    } else if (character === " " && !inString) {
      startNew = true;
      continue;
    } else if (character === '"') {
      inString = !inString;
      continue;
    }
    if (startNew) {
      argv.push(character);
      startNew = false;
    } else {
      const last = argv.length - 1;
      argv[last] = `${argv[last] ?? ""}${character}`;
    }
  }
  return inString ? undefined : argv;
};

const parsedFlagMiB = (
  token: string,
  flag: RegExp,
): number | "absent" | "unrecognized" => {
  const match = flag.exec(token);
  if (match === null) return "absent";
  const raw = match[1];
  if (raw === undefined) return "unrecognized";
  if (raw === "") return 0;
  if (!/^\+?\d+$/u.test(raw)) return "unrecognized";
  const mib = Number(raw);
  return Number.isSafeInteger(mib) ? mib : "unrecognized";
};

/**
 * Derive the worker old-generation heap from launch flags the caller already
 * recovered. The raw `NODE_OPTIONS` string is not retained. This does not read
 * `process.env`.
 */
export const resolveRegexWorkerHeap = (
  execArgv: readonly string[],
  nodeOptions: string | undefined,
  request: RegexWorkerHeapRequest = DEFAULT_REGEX_WORKER_HEAP_REQUEST,
): RegexWorkerHeapLimit => {
  const requestedHeap = {
    kind: "effective" as const,
    mib: request.heapMiB,
    overridden: false as const,
  };
  const fromEnvironment =
    nodeOptions === undefined ? [] : nodeOptionsArgv(nodeOptions);
  const tokens = [...(fromEnvironment ?? []), ...execArgv];
  // An absent NODE_OPTIONS lets the env file supply one, including a percentage
  // that beats a later absolute flag. The file's text is not launch provenance.
  // A Node config file can inject nodeOptions even when NODE_OPTIONS was
  // recovered. The file is not read back.
  if (
    tokens.some((token) => CONFIG_FILE_FLAG.test(token)) ||
    (nodeOptions === undefined &&
      tokens.some((token) => ENV_FILE_FLAG.test(token)))
  )
    return { kind: "unknown" };
  let limit: RegexWorkerHeapLimit =
    fromEnvironment === undefined ? { kind: "unknown" } : requestedHeap;
  let percentage = false;
  let maxHeap: "clear" | "positive" | "unrecognized" = "clear";
  for (const token of tokens) {
    if (OLD_SPACE_PERCENT_FLAG.test(token)) {
      percentage = true;
      limit = { kind: "unknown" };
      continue;
    }
    // A percentage flag wins over every absolute flag, including a later one.
    if (percentage) continue;
    const totalHeap = parsedFlagMiB(token, MAX_HEAP_FLAG);
    if (totalHeap === "unrecognized") {
      maxHeap = "unrecognized";
      continue;
    }
    if (totalHeap !== "absent") {
      if (maxHeap !== "unrecognized")
        maxHeap = totalHeap > 0 ? "positive" : "clear";
      continue;
    }
    const parsed = parsedFlagMiB(token, OLD_SPACE_FLAG);
    if (parsed === "absent") continue;
    if (parsed === "unrecognized") {
      limit = { kind: "unknown" };
      continue;
    }
    limit =
      parsed > 0
        ? { kind: "effective", mib: parsed, overridden: true }
        : requestedHeap;
  }
  // A positive total-heap cap is not an old-generation size. Zero clears it
  // and leaves the old-space result. An unparsed value does not.
  return maxHeap === "clear" ? limit : { kind: "unknown" };
};

/** Provenance of the `NODE_OPTIONS` value Node applied before user code ran. */
export type LaunchNodeOptions =
  | { readonly kind: "recovered"; readonly value: string | undefined }
  | { readonly kind: "unrecoverable" };

const nodeOptionsKey = Buffer.from("NODE_OPTIONS=");

/** First `NODE_OPTIONS` entry, matching `getenv`. The surrounding block is not retained. */
const nodeOptionsFromEnviron = (
  raw: Buffer,
): string | undefined | "invalid" => {
  let offset = 0;
  while (offset < raw.length) {
    const end = raw.indexOf(0, offset);
    const entryEnd = end === -1 ? raw.length : end;
    const entry = raw.subarray(offset, entryEnd);
    if (
      entry.length >= nodeOptionsKey.length &&
      entry.subarray(0, nodeOptionsKey.length).equals(nodeOptionsKey)
    ) {
      try {
        return decodeStrictUtf8(
          entry.subarray(nodeOptionsKey.length),
          "strip-signature",
        );
      } catch {
        return "invalid";
      }
    }
    if (end === -1) break;
    offset = end + 1;
  }
  return undefined;
};

/**
 * Linux keeps the `execve` environment in `/proc/self/environ` after
 * `process.env` is rewritten. Other platforms have no equivalent immutable
 * block, so the launch value stays unrecoverable there.
 */
export const readLaunchNodeOptions = (
  platform: NodeJS.Platform,
): LaunchNodeOptions => {
  if (platform !== "linux") return { kind: "unrecoverable" };
  let raw: Buffer;
  try {
    raw = readFileSync("/proc/self/environ");
  } catch {
    return { kind: "unrecoverable" };
  }
  const value = nodeOptionsFromEnviron(raw);
  return value === "invalid"
    ? { kind: "unrecoverable" }
    : { kind: "recovered", value };
};

/**
 * Node options that take the next command-line token when it is not `=`.
 * Boolean flags and V8 flags do not. Names are the dashed form Node looks up
 * after replacing `_`. An option absent from both sets, followed by the
 * program entry, leaves the boundary unrecoverable.
 */
const VALUE_OPTION_NAMES =
  "--allow-fs-read,--allow-fs-write,--build-sea,--build-snapshot-config,--conditions,--cpu-prof-dir,--cpu-prof-interval,--cpu-prof-name,--debug-port,--diagnostic-dir,--disable-proto,--disable-warning,--dns-result-order,--env-file,--env-file-if-exists,--eval,--experimental-config-file,--experimental-default-type,--experimental-loader,--experimental-sea-config,--experimental-test-isolation,--heap-prof-dir,--heap-prof-interval,--heap-prof-name,--heapsnapshot-near-heap-limit,--heapsnapshot-signal,--icu-data-dir,--import,--input-type,--inspect-port,--inspect-publish-uid,--loader,--localstorage-file,--max-http-header-size,--max-old-space-size-percentage,--network-family-autoselection-attempt-timeout,--openssl-config,--print,--redirect-warnings,--report-dir,--report-directory,--report-filename,--report-signal,--require,--run,--secure-heap,--secure-heap-min,--snapshot-blob,--test-concurrency,--test-coverage-branches,--test-coverage-exclude,--test-coverage-functions,--test-coverage-include,--test-coverage-lines,--test-global-setup,--test-isolation,--test-name-pattern,--test-reporter,--test-reporter-destination,--test-shard,--test-skip-pattern,--test-timeout,--title,--tls-cipher-list,--tls-keylog,--trace-event-categories,--trace-event-file-pattern,--trace-require-module,--unhandled-rejections,--use-largepages,--v8-pool-size,--watch-kill-signal,--watch-path,-C,-e,-p,-pe,-r";
const FLAG_OPTION_NAMES =
  "--abort-on-uncaught-exception,--allow-addons,--allow-child-process,--allow-inspector,--allow-net,--allow-wasi,--allow-worker,--build-snapshot,--check,--completion-bash,--cpu-prof,--disable-sigusr1,--disable-wasm-trap-handler,--disallow-code-generation-from-strings,--enable-etw-stack-walking,--enable-fips,--enable-network-family-autoselection,--enable-source-maps,--entry-url,--experimental-addon-modules,--experimental-async-context-frame,--experimental-default-config-file,--experimental-eventsource,--experimental-import-meta-resolve,--experimental-inspector-network-resource,--experimental-network-inspection,--experimental-permission,--experimental-print-required-tla,--experimental-quic,--experimental-storage-inspection,--experimental-stream-iter,--experimental-test-coverage,--experimental-test-module-mocks,--experimental-transform-types,--experimental-vm-modules,--experimental-webstorage,--experimental-worker-inspection,--expose-gc,--force-context-aware,--force-fips,--force-node-api-uncaught-exceptions-policy,--frozen-intrinsics,--heap-prof,--heap-snapshot-on-oom,--help,--huge-max-old-generation-size,--insecure-http-parser,--inspect,--inspect-brk,--inspect-wait,--interactive,--interpreted-frames-native-stack,--jitless,--max-heap-size,--max-old-space-size,--max-semi-space-size,--no-addons,--no-async-context-frame,--no-deprecation,--no-experimental-detect-module,--no-experimental-fetch,--no-experimental-global-customevent,--no-experimental-global-navigator,--no-experimental-global-webcrypto,--no-experimental-repl-await,--no-experimental-require-module,--no-experimental-sqlite,--no-experimental-strip-types,--no-experimental-websocket,--no-experimental-webstorage,--no-extra-info-on-fatal-exception,--no-force-async-hooks-checks,--no-global-search-paths,--no-network-family-autoselection,--no-require-module,--no-strip-types,--no-warnings,--node-memory-debug,--openssl-legacy-provider,--openssl-shared-config,--pending-deprecation,--permission,--permission-audit,--preserve-symlinks,--preserve-symlinks-main,--prof,--prof-process,--report-compact,--report-exclude-env,--report-exclude-network,--report-on-fatalerror,--report-on-signal,--report-uncaught-exception,--test,--test-force-exit,--test-only,--test-rerun-failures,--test-update-snapshots,--throw-deprecation,--tls-max-v1.2,--tls-max-v1.3,--tls-min-v1.0,--tls-min-v1.1,--tls-min-v1.2,--tls-min-v1.3,--trace-atomics-wait,--trace-deprecation,--trace-env,--trace-env-js-stack,--trace-env-native-stack,--trace-exit,--trace-promises,--trace-sigint,--trace-sync-io,--trace-tls,--trace-uncaught,--trace-warnings,--track-heap-objects,--use-bundled-ca,--use-env-proxy,--use-openssl-ca,--use-system-ca,--v8-options,--version,--watch,--watch-preserve-output,--zero-fill-buffers,-c,-h,-i,-v";
const VALUE_OPTIONS = new Set(VALUE_OPTION_NAMES.split(","));
const FLAG_OPTIONS = new Set(FLAG_OPTION_NAMES.split(","));

/** Provenance of the Node option tokens that were `process.execArgv` at start. */
export type LaunchExecArgv =
  | { readonly kind: "recovered"; readonly value: readonly string[] }
  | { readonly kind: "unrecoverable" };

const commandLineTokens = (raw: Buffer): readonly string[] | "invalid" => {
  if (raw.length === 0) return "invalid";
  const end = raw[raw.length - 1] === 0 ? raw.length - 1 : raw.length;
  const tokens: string[] = [];
  const decoder = strictUtf8Decoder("strip-signature");
  let offset = 0;
  while (offset < end) {
    const next = raw.indexOf(0, offset);
    const tokenEnd = next === -1 || next > end ? end : next;
    try {
      tokens.push(decoder.decode(raw.subarray(offset, tokenEnd)));
    } catch {
      return "invalid";
    }
    if (next === -1 || next >= end) break;
    offset = next + 1;
  }
  return tokens.length === 0 ? "invalid" : tokens;
};

const normalizedOption = (
  token: string,
): { readonly name: string; readonly inline: boolean } => {
  if (!token.startsWith("--")) return { name: token, inline: false };
  const equals = token.indexOf("=");
  const rawName = equals === -1 ? token : token.slice(0, equals);
  return {
    name: `${rawName.slice(0, 2)}${rawName.slice(2).replaceAll("_", "-")}`,
    inline: equals !== -1,
  };
};

/** Options whose argument is the program entry rather than a script path. */
const ENTRY_OPTIONS = new Set(["-e", "--eval", "-p", "--print", "-pe"]);

/**
 * Node option tokens from an `execve` command line. The executable and the
 * program entry are omitted. `--` ends the list and is omitted. A title
 * overwrite leaves one token and null padding, which has no program entry.
 * The buffer is not retained.
 */
export const execArgvFromCommandLine = (raw: Buffer): LaunchExecArgv => {
  const tokens = commandLineTokens(raw);
  if (tokens === "invalid" || tokens.length === 0 || tokens[0] === "")
    return { kind: "unrecoverable" };
  const exec: string[] = [];
  let sawEntry = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token.length === 0) return { kind: "unrecoverable" };
    if (token === "--") {
      const entry = tokens[index + 1];
      if (entry === undefined || entry.length === 0)
        return { kind: "unrecoverable" };
      sawEntry = true;
      break;
    }
    if (token === "-" || !token.startsWith("-")) {
      sawEntry = true;
      break;
    }
    exec.push(token);
    const option = normalizedOption(token);
    const entryOption = ENTRY_OPTIONS.has(option.name);
    if (option.inline) {
      if (entryOption) sawEntry = true;
      continue;
    }
    if (VALUE_OPTIONS.has(option.name)) {
      const value = tokens[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("-"))
        return { kind: "unrecoverable" };
      exec.push(value);
      index += 1;
      if (entryOption) sawEntry = true;
      continue;
    }
    if (FLAG_OPTIONS.has(option.name)) continue;
    const next = tokens[index + 1];
    if (next !== undefined && (next.length === 0 || !next.startsWith("-")))
      return { kind: "unrecoverable" };
  }
  // No script, eval string, or stdin entry. A title-only buffer looks like this.
  if (!sawEntry) return { kind: "unrecoverable" };
  return { kind: "recovered", value: exec };
};

/**
 * Linux keeps the `execve` argument vector in `/proc/self/cmdline` after
 * `process.execArgv` is rewritten. `process.title` and `--title` overwrite
 * that vector. Other platforms have no equivalent immutable block, so the
 * launch options stay unrecoverable there.
 */
export const readLaunchExecArgv = (
  platform: NodeJS.Platform,
): LaunchExecArgv => {
  if (platform !== "linux") return { kind: "unrecoverable" };
  let raw: Buffer;
  try {
    raw = readFileSync("/proc/self/cmdline");
  } catch {
    return { kind: "unrecoverable" };
  }
  return execArgvFromCommandLine(raw);
};

/** Heap for this process. Unrecoverable launch provenance stays unknown. */
export const resolveLaunchRegexWorkerHeap = (
  launchExecArgv: LaunchExecArgv,
  launchNodeOptions: LaunchNodeOptions,
  request: RegexWorkerHeapRequest = DEFAULT_REGEX_WORKER_HEAP_REQUEST,
): RegexWorkerHeapLimit =>
  launchExecArgv.kind === "unrecoverable" ||
  launchNodeOptions.kind === "unrecoverable"
    ? { kind: "unknown" }
    : resolveRegexWorkerHeap(
        launchExecArgv.value,
        launchNodeOptions.value,
        request,
      );

const launchRegexWorkerHeap = resolveLaunchRegexWorkerHeap(
  readLaunchExecArgv(HOST_PLATFORM.platform),
  readLaunchNodeOptions(HOST_PLATFORM.platform),
);

/** Runtime requests can change the worker's heap only when launch left it configurable. */
const heapForWorkerRequest = (
  request: RegexWorkerHeapRequest,
): RegexWorkerHeapLimit =>
  launchRegexWorkerHeap.kind === "effective" &&
  !launchRegexWorkerHeap.overridden
    ? { ...launchRegexWorkerHeap, mib: request.heapMiB }
    : launchRegexWorkerHeap;

const heapBound = (
  heap: RegexWorkerHeapLimit,
  request: RegexWorkerHeapRequest,
  recovery = regexWorkerHeapRequestRecovery(request),
): string => {
  if (heap.kind === "unknown")
    return `The worker requests ${String(request.heapMiB)} MiB. The effective old-generation heap was not established from the launch flags. --max-old-space-size, --max-old-space-size-percentage, --max-heap-size, --env-file, --env-file-if-exists, --experimental-config-file, and --experimental-default-config-file can change that request. ${recovery}`;
  const override = `A positive Node --max-old-space-size, including NODE_OPTIONS, overrides the ${String(request.heapMiB)} MiB worker request`;
  return heap.overridden
    ? `${override} and sets this process's effective heap to ${String(heap.mib)} MiB. ${recovery}`
    : `${override}. This process has no positive override, so the effective heap is ${String(heap.mib)} MiB. ${recovery}`;
};

/**
 * Capability text for the supervised ECMAScript matching boundary: the
 * effective budgets, their sources, and where to change them. Providers repeat
 * it per search operation, so setting bounds and step-by-step recovery stay
 * with the deadline and heap errors instead.
 */
export const regexMatchingLimitation = (
  heap: RegexWorkerHeapLimit,
  deadline: RegexMatchingDeadline = DEFAULT_REGEX_MATCHING_DEADLINE,
  request: RegexWorkerHeapRequest = DEFAULT_REGEX_WORKER_HEAP_REQUEST,
): string => {
  const requested = `${String(request.heapMiB)} MiB worker heap request (source ${request.source})`;
  const heapText =
    heap.kind === "unknown"
      ? `a ${requested}; launch heap flags can change the effective old-generation heap, which was not established`
      : heap.overridden
        ? `an effective ${String(heap.mib)} MiB old-generation heap set by a positive Node --max-old-space-size over its ${requested}`
        : `an effective ${String(heap.mib)} MiB old-generation heap from its ${requested}`;
  return `Regex mode uses ECMAScript Unicode semantics in a cancellable worker with a ${String(deadline.deadlineMs)} ms matching deadline (source ${deadline.source}) and ${heapText}. inspect_analysis_settings and update_analysis_settings read and change regex.matching_deadline_ms and regex.worker_heap_request_mib; ${REGEX_MATCHING_DEADLINE_SETTING} and ${REGEX_WORKER_HEAP_REQUEST_SETTING} seed them at launch. Deadline and heap errors report the bounds and recovery. Matching failure leaves the service available.`;
};

/** Capability text for this process's launch heap, deadline, and heap request. */
export const launchRegexMatchingLimitation = (
  deadline: RegexMatchingDeadline = DEFAULT_REGEX_MATCHING_DEADLINE,
  request: RegexWorkerHeapRequest = DEFAULT_REGEX_WORKER_HEAP_REQUEST,
): string => {
  const limitation = readRuntimeSetting(() =>
    regexMatchingLimitation(heapForWorkerRequest(request), deadline, request),
  );
  return limitation.ok
    ? limitation.value
    : "Regex mode is unavailable until its invalid launch configuration is corrected with update_analysis_settings or by restarting REA. Inspect analysis settings for the affected value.";
};

/**
 * Capability text for the default deadline on this process's launch heap.
 * Providers that resolved `REA_REGEX_MATCHING_DEADLINE_MS` pass that value to
 * `launchRegexMatchingLimitation` instead of this constant.
 */
export const REGEX_MATCHING_LIMITATION = launchRegexMatchingLimitation();

/** Supervised regex deadline. The worker heap is a separate, launch-flag-sensitive cap. */
export const regexMatchingDeadlineError = (
  operation: string,
  deadline: RegexMatchingDeadline = DEFAULT_REGEX_MATCHING_DEADLINE,
): AnalysisResourceConstraintError =>
  new AnalysisResourceConstraintError(
    operation,
    "cpu",
    `Regex matching exceeded its supervised deadline of ${String(deadline.deadlineMs)} ms (source ${deadline.source}). ${regexMatchingDeadlineRecovery(deadline)}`,
    {
      matching_deadline_ms: deadline.deadlineMs,
      matching_deadline_source: deadline.source,
    },
    {
      limit: analysisSettingLimit(
        "regex.matching_deadline_ms",
        deadline.deadlineMs,
        deadline.source,
      ),
      remediationAction: `${regexMatchingDeadlineRecovery(deadline)} Simplify the ECMAScript Unicode regex or use literal mode, then retry.`,
      // A one-shot invocation has ended its session before the caller retries.
      continuingCallerGuidance: {
        userMessage: "The service remains available.",
        remediationAction: `${regexMatchingDeadlineContinuingRecovery(deadline)} Simplify the ECMAScript Unicode regex or use literal mode, then retry in the same session.`,
      },
    },
  );

/** Regex worker heap at the effective old-generation limit, which a launch flag can change. */
export const regexWorkerHeapError = (
  operation: string,
  cause: Error,
  heap: RegexWorkerHeapLimit = launchRegexWorkerHeap,
  request: RegexWorkerHeapRequest = DEFAULT_REGEX_WORKER_HEAP_REQUEST,
): AnalysisResourceConstraintError =>
  new AnalysisResourceConstraintError(
    operation,
    "memory",
    heap.kind === "effective"
      ? `Regex worker exhausted its effective ${String(heap.mib)} MiB old-generation heap.`
      : "Regex worker exhausted its old-generation heap. The effective heap was not established.",
    heap.kind === "effective"
      ? {
          worker_heap_mib: heap.mib,
          requested_worker_heap_mib: request.heapMiB,
          requested_worker_heap_source: request.source,
        }
      : {
          requested_worker_heap_mib: request.heapMiB,
          requested_worker_heap_source: request.source,
        },
    {
      cause,
      ...(heap.kind === "effective" && !heap.overridden
        ? {
            limit: analysisSettingLimit(
              "regex.worker_heap_request_mib",
              request.heapMiB,
              request.source,
            ),
          }
        : {}),
      remediationAction: `${heapBound(heap, request)} Set ${REGEX_WORKER_HEAP_REQUEST_SETTING} in the environment that starts the next REA invocation. Restart REA after changing --max-old-space-size. A launch --max-old-space-size-percentage takes precedence over that flag in either order. Simplify the pattern or use literal mode.`,
      continuingCallerGuidance: {
        remediationAction: `${heapBound(heap, request, regexWorkerHeapRequestContinuingRecovery(request))} Call update_analysis_settings with setting regex.worker_heap_request_mib to change the request for the next worker in this session. Launch heap flags can still override it. The launch seed remains ${REGEX_WORKER_HEAP_REQUEST_SETTING}. A launch --max-old-space-size-percentage takes precedence over --max-old-space-size in either order. Simplify the pattern or use literal mode.`,
      },
    },
  );
/**
 * A pattern the regex engine rejects. The caller sees the engine's syntax
 * error on `pattern` and can retry in literal mode. The worker, providers that
 * check the pattern before starting, and remote engines that report their own
 * syntax error (whose message then replaces the default) share this result.
 */
export const invalidRegexPatternError = (
  operation: string,
  reason: string,
  options: AnalysisErrorOptions & { readonly userMessage?: string } = {},
): AnalysisInputError =>
  new AnalysisInputError(
    operation,
    {
      ...options,
      userMessage: options.userMessage ?? `Invalid regex pattern: ${reason}`,
      remediationAction:
        "Correct the pattern using the reported regex syntax error, or select mode literal to search for the text literally, then retry.",
    },
    [{ path: ["pattern"], reason: "invalid_format", message: reason }],
  );

type WorkerReply =
  | { readonly kind: "matched"; readonly indices: readonly number[] }
  | { readonly kind: "invalid_pattern"; readonly reason: string }
  | { readonly kind: "malformed" }
  | { readonly kind: "invalid_indices" };

const parseWorkerReply = (
  message: unknown,
  valueCount: number,
): WorkerReply => {
  if (!isRecord(message) || Object.keys(message).length !== 2)
    return { kind: "malformed" };
  if (message.status === "invalid_pattern") {
    if (!Object.hasOwn(message, "reason") || typeof message.reason !== "string")
      return { kind: "malformed" };
    return { kind: "invalid_pattern", reason: message.reason };
  }
  if (
    message.status !== "matched" ||
    !Object.hasOwn(message, "indices") ||
    !Array.isArray(message.indices)
  )
    return { kind: "malformed" };
  const indices: unknown[] = message.indices;
  let previous = -1;
  let outOfOrderOrRange = false;
  for (let position = 0; position < indices.length; position += 1) {
    const index = indices[position];
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0)
      return { kind: "malformed" };
    if (index >= valueCount || index <= previous) outOfOrderOrRange = true;
    previous = index;
  }
  if (outOfOrderOrRange) return { kind: "invalid_indices" };
  return { kind: "matched", indices: indices as number[] };
};

const REGEX_PACK_CHUNK_ITEMS = 4096;
const REGEX_PACK_CHUNK_CHARS = 262_144;

interface PackedRegexChunk {
  readonly buffer: ArrayBuffer;
  readonly encoding: "latin1" | "utf16le";
  readonly startIndex: number;
  readonly count: number;
}

interface PackedRegexValues {
  readonly lengthsBuffer: ArrayBuffer;
  readonly chunks: readonly PackedRegexChunk[];
}

interface PackedRegexTransfer {
  readonly packed: PackedRegexValues;
  readonly transferList: ArrayBuffer[];
}

const packRegexValues = (values: readonly string[]): PackedRegexTransfer => {
  const count = values.length;
  const lengths = new Uint32Array(count);
  const chunks: PackedRegexChunk[] = [];
  const transferList: ArrayBuffer[] = [lengths.buffer];
  let index = 0;
  while (index < count) {
    const startIndex = index;
    const parts: string[] = [];
    let chars = 0;
    const itemLimit = Math.min(count, startIndex + REGEX_PACK_CHUNK_ITEMS);
    while (index < itemLimit) {
      const value = values[index]!;
      const len = value.length;
      if (parts.length > 0 && chars + len > REGEX_PACK_CHUNK_CHARS) break;
      lengths[index] = len;
      parts.push(value);
      chars += len;
      index += 1;
    }
    const joined = parts.join("");
    const isAscii = Buffer.byteLength(joined, "utf8") === joined.length;
    const encoding: "latin1" | "utf16le" = isAscii ? "latin1" : "utf16le";
    const byteLength = isAscii ? joined.length : joined.length * 2;
    const buffer = new ArrayBuffer(byteLength);
    if (byteLength > 0) {
      Buffer.from(buffer).write(joined, encoding);
    }
    chunks.push({
      buffer,
      encoding,
      startIndex,
      count: index - startIndex,
    });
    transferList.push(buffer);
  }
  return {
    packed: {
      lengthsBuffer: lengths.buffer,
      chunks,
    },
    transferList,
  };
};

// Code is constant; patterns cross workerData and candidate strings are
// transferred in chunked off-heap ArrayBuffers so structured cloning neither
// allocates millions of V8 heap strings upfront nor stalls on per-item bridges.
// process.getBuiltinModule loads synchronously in both CJS and ESM workers
// without async import overhead or ESM customization hook startup.
const WORKER_SOURCE = String.raw`
const { parentPort } = process.getBuiltinModule("node:worker_threads");
parentPort.on("message", (job) => {
  let expression;
  try {
    expression = new RegExp(job.pattern, job.caseSensitive ? "u" : "iu");
  } catch (cause) {
    parentPort.postMessage({ status: "invalid_pattern", reason: cause instanceof Error ? cause.message : String(cause) });
    return;
  }
  const indices = [];
  const { lengthsBuffer, chunks } = job.packed;
  const lengths = new Uint32Array(lengthsBuffer);
  for (let c = 0; c < chunks.length; c += 1) {
    const chunk = chunks[c];
    const block = Buffer.from(chunk.buffer).toString(chunk.encoding);
    let offset = 0;
    for (let index = chunk.startIndex, end = index + chunk.count; index < end; index += 1) {
      const len = lengths[index];
      if (expression.test(block.slice(offset, offset + len)))
        indices.push(index);
      offset += len;
    }
  }
  parentPort.postMessage({ status: "matched", indices });
});
`;

// Workers are pooled by heap class: spawning one costs ~10 ms, which dominates
// small searches. A worker is reused only after a clean reply. A deadline,
// abort, error, or exit stops that worker. It stays in the pool, and counts
// toward the cap, until its thread exits. A failed stop keeps the slot and is
// retried; the caller's match error keeps its identity and records the stop
// failure beside it.
const MAX_POOLED_REGEX_WORKERS = 4;
const REGEX_WORKER_IDLE_MS = 10_000;
const REGEX_WORKER_RESOURCE = "regex-worker";

interface PooledRegexWorker {
  readonly worker: Worker;
  readonly heapMiB: number;
  busy: boolean;
  /** The thread has exited and the entry has left the pool. */
  exited: boolean;
  /** `terminate()` is in flight and has not failed. */
  stopping: boolean;
  /** Last `terminate()` rejection. The entry stays counted until a later stop exits. */
  stopFailure?: unknown;
  idleTimer?: NodeJS.Timeout | undefined;
  stopPromise?: Promise<void> | undefined;
  resolveStop?: (() => void) | undefined;
  rejectStop?: ((cause: unknown) => void) | undefined;
  onMessage?: ((message: unknown) => void) | undefined;
  onError?: ((cause: Error & { code?: string }) => void) | undefined;
  onExit?: ((code: number) => void) | undefined;
}

interface RegexWorkerWaiter {
  readonly heapMiB: number;
  readonly grant: (entry: PooledRegexWorker) => void;
  readonly fail: (cause: unknown) => void;
}

const regexWorkerPool: PooledRegexWorker[] = [];
const regexWorkerWaiters: RegexWorkerWaiter[] = [];

const isIdleRegexWorker = (entry: PooledRegexWorker): boolean =>
  !entry.busy && !entry.stopping && entry.stopFailure === undefined;

const clearRegexWorkerHandlers = (entry: PooledRegexWorker): void => {
  entry.onMessage = undefined;
  entry.onError = undefined;
  entry.onExit = undefined;
};

const regexWorkerStopFailure = (
  operation: string,
  entry: PooledRegexWorker,
  cause: unknown,
): AnalysisOutputError =>
  new AnalysisOutputError(
    operation,
    "Regex worker did not stop after its match ended",
    {
      cause,
      diagnostics: { worker_heap_mib: entry.heapMiB },
      cleanup: {
        reason: "Regex worker termination failed",
        resources: [REGEX_WORKER_RESOURCE],
      },
    },
  );

const forgetRegexWorkerStop = (entry: PooledRegexWorker): void => {
  entry.resolveStop = undefined;
  entry.rejectStop = undefined;
};

/** Drop the worker only after its thread exits, then let the allocator use the slot. */
const settleRegexWorkerExit = (entry: PooledRegexWorker): void => {
  if (entry.exited) return;
  entry.exited = true;
  entry.stopping = false;
  entry.busy = false;
  entry.stopFailure = undefined;
  if (entry.idleTimer !== undefined) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
  const index = regexWorkerPool.indexOf(entry);
  if (index !== -1) regexWorkerPool.splice(index, 1);
  const resolve = entry.resolveStop;
  forgetRegexWorkerStop(entry);
  resolve?.();
  serveRegexWaiters();
};

/**
 * Stop `entry` and keep it counted until exit. A rejection leaves it owned
 * with `stopFailure` set so a later allocation can retry. The returned
 * promise rejects only for that failure; exit fulfills it.
 */
const beginStopRegexWorker = (entry: PooledRegexWorker): Promise<void> => {
  if (entry.exited) return Promise.resolve();
  if (entry.stopPromise !== undefined && entry.stopFailure === undefined)
    return entry.stopPromise;
  entry.stopFailure = undefined;
  entry.stopping = true;
  entry.busy = false;
  if (entry.idleTimer !== undefined) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
  entry.worker.ref();
  let resolveStop!: () => void;
  let rejectStop!: (cause: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveStop = resolve;
    rejectStop = reject;
  });
  entry.resolveStop = resolveStop;
  entry.rejectStop = rejectStop;
  entry.stopPromise = promise;
  void promise.catch(() => undefined);
  // `terminate()` fulfills with the exit code once the thread has stopped.
  // The exit listener settles the same way when the thread dies on its own.
  void entry.worker.terminate().then(
    () => {
      settleRegexWorkerExit(entry);
    },
    (cause: unknown) => {
      if (entry.exited || entry.rejectStop !== rejectStop) return;
      entry.stopping = false;
      entry.stopFailure = cause;
      entry.stopPromise = undefined;
      forgetRegexWorkerStop(entry);
      entry.worker.unref();
      rejectStop(cause);
    },
  );
  return promise;
};

const grantIdleRegexWorker = (
  entry: PooledRegexWorker,
  waiter: RegexWorkerWaiter,
): void => {
  entry.busy = true;
  if (entry.idleTimer !== undefined) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
  entry.worker.ref();
  waiter.grant(entry);
};

let servingRegexWaiters = false;
let regexWaitersNeedService = false;

const serveRegexWaiters = (): void => {
  if (servingRegexWaiters) {
    regexWaitersNeedService = true;
    return;
  }
  servingRegexWaiters = true;
  try {
    do {
      regexWaitersNeedService = false;
      serveRegexWaitersNow();
    } while (regexWaitersNeedService);
  } finally {
    servingRegexWaiters = false;
  }
};

const serveRegexWaitersNow = (): void => {
  for (const entry of regexWorkerPool) {
    if (entry.stopFailure !== undefined && !entry.stopping)
      void beginStopRegexWorker(entry);
  }
  for (let i = 0; i < regexWorkerWaiters.length;) {
    const waiter = regexWorkerWaiters[i]!;
    const idle = regexWorkerPool.find(
      (entry) => isIdleRegexWorker(entry) && entry.heapMiB === waiter.heapMiB,
    );
    if (idle === undefined) {
      i += 1;
      continue;
    }
    regexWorkerWaiters.splice(i, 1);
    grantIdleRegexWorker(idle, waiter);
  }
  for (let i = 0; i < regexWorkerWaiters.length;) {
    if (regexWorkerPool.length < MAX_POOLED_REGEX_WORKERS) {
      const waiter = regexWorkerWaiters[i]!;
      regexWorkerWaiters.splice(i, 1);
      try {
        waiter.grant(spawnRegexWorker(waiter.heapMiB));
      } catch (cause: unknown) {
        waiter.fail(cause);
      }
      continue;
    }
    // One incompatible idle worker fills one queued heap. Stopping every
    // idle worker here would discard workers the caller did not need.
    const reclaimable = regexWorkerPool.find((entry) =>
      isIdleRegexWorker(entry),
    );
    if (reclaimable !== undefined) void beginStopRegexWorker(reclaimable);
    break;
  }
};

const spawnRegexWorker = (heapMiB: number): PooledRegexWorker => {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    resourceLimits: { maxOldGenerationSizeMb: heapMiB },
  });
  const entry: PooledRegexWorker = {
    worker,
    heapMiB,
    busy: true,
    exited: false,
    stopping: false,
  };
  worker.on("message", (message: unknown) => entry.onMessage?.(message));
  worker.on("error", (cause: Error & { code?: string }) => {
    const settle = entry.onError;
    settle?.(cause);
    void beginStopRegexWorker(entry);
  });
  worker.on("exit", (code: number) => {
    const settle = entry.onExit;
    settleRegexWorkerExit(entry);
    settle?.(code);
  });
  regexWorkerPool.push(entry);
  return entry;
};

const acquireRegexWorker = async (
  heapMiB: number,
  signal: AbortSignal | undefined,
): Promise<PooledRegexWorker | undefined> => {
  const idle = regexWorkerPool.find(
    (entry) => isIdleRegexWorker(entry) && entry.heapMiB === heapMiB,
  );
  if (idle !== undefined) {
    idle.busy = true;
    if (idle.idleTimer !== undefined) clearTimeout(idle.idleTimer);
    idle.idleTimer = undefined;
    idle.worker.ref();
    return idle;
  }
  // Spawning and reclaiming go through serveRegexWaiters so one path owns
  // the cap. An idle match above only borrows a worker already counted.
  return new Promise<PooledRegexWorker | undefined>((resolve, reject) => {
    const waiter: RegexWorkerWaiter = {
      heapMiB,
      grant: (entry: PooledRegexWorker) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(entry);
      },
      fail: (cause: unknown) => {
        signal?.removeEventListener("abort", onAbort);
        reject(
          cause instanceof Error ? cause : new Error("Regex worker failed"),
        );
      },
    };
    const onAbort = (): void => {
      const index = regexWorkerWaiters.indexOf(waiter);
      if (index !== -1) regexWorkerWaiters.splice(index, 1);
      resolve(undefined);
    };
    regexWorkerWaiters.push(waiter);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    serveRegexWaiters();
  });
};

const armRegexWorkerIdleTimer = (entry: PooledRegexWorker): void => {
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = undefined;
    if (isIdleRegexWorker(entry)) void beginStopRegexWorker(entry);
  }, REGEX_WORKER_IDLE_MS);
  entry.idleTimer.unref();
};

const releaseRegexWorker = (entry: PooledRegexWorker): void => {
  entry.busy = false;
  clearRegexWorkerHandlers(entry);
  entry.worker.unref();
  // The shared allocator matches this worker or reclaims it for another heap.
  // A same-heap-only grant here left that waiter waiting out the idle reap.
  serveRegexWaiters();
  if (isIdleRegexWorker(entry)) armRegexWorkerIdleTimer(entry);
};

const ensureRegexWorkerStopped = async (
  operation: string,
  entry: PooledRegexWorker,
): Promise<AnalysisOutputError | undefined> => {
  if (entry.exited && entry.stopFailure === undefined) return undefined;
  try {
    await beginStopRegexWorker(entry);
    return undefined;
  } catch (cause: unknown) {
    return regexWorkerStopFailure(operation, entry, cause);
  }
};

export interface RegexConfigurationSnapshot {
  readonly deadline: RegexMatchingDeadline;
  readonly heapRequest: RegexWorkerHeapRequest;
}

/** Capture the operation's admitted regex values without starting work. */
export const snapshotRegexConfiguration = (
  selectedDeadline: RegexMatchingDeadline = DEFAULT_REGEX_MATCHING_DEADLINE,
  selectedHeap: RegexWorkerHeapRequest = DEFAULT_REGEX_WORKER_HEAP_REQUEST,
): Result<RegexConfigurationSnapshot, ConfigurationError> =>
  readRuntimeSetting(() => ({
    deadline: {
      deadlineMs: selectedDeadline.deadlineMs,
      source: selectedDeadline.source,
    },
    heapRequest: {
      heapMiB: selectedHeap.heapMiB,
      source: selectedHeap.source,
    },
  }));

/** Match an inventory off the service thread; clean workers return to the pool, stuck ones are retired. */
export const matchRegexValues = async (input: {
  readonly operation: string;
  readonly pattern: string;
  readonly caseSensitive: boolean;
  readonly values: readonly string[];
  readonly signal?: AbortSignal | undefined;
  /** Resolved deadline. Omitted means the 5000 ms default, not ambient `process.env`. */
  readonly deadline?: RegexMatchingDeadline | undefined;
  /** Resolved heap request. Omitted means the 128 MiB default, not ambient `process.env`. */
  readonly heapRequest?: RegexWorkerHeapRequest | undefined;
}): Promise<Result<readonly number[], AnalysisError>> => {
  if (input.signal?.aborted)
    return err(cancelledBy(input.operation, input.signal));
  const admitted = snapshotRegexConfiguration(
    input.deadline,
    input.heapRequest,
  );
  if (!admitted.ok) return admitted;
  if (input.values.length === 0) {
    try {
      new RegExp(input.pattern, input.caseSensitive ? "u" : "iu");
    } catch (cause: unknown) {
      return err(
        invalidRegexPatternError(input.operation, errorMessage(cause)),
      );
    }
    return ok([]);
  }
  const { deadline, heapRequest } = admitted.value;
  const transfer = packRegexValues(input.values);
  const startedAt = performance.now();
  const queueSignal =
    input.signal === undefined
      ? AbortSignal.timeout(deadline.deadlineMs)
      : AbortSignal.any([
          input.signal,
          AbortSignal.timeout(deadline.deadlineMs),
        ]);
  let entry: PooledRegexWorker | undefined;
  try {
    entry = await acquireRegexWorker(heapRequest.heapMiB, queueSignal);
  } catch (cause: unknown) {
    return err(
      new AnalysisOutputError(input.operation, "Cannot start regex worker", {
        cause,
      }),
    );
  }
  if (entry === undefined)
    return err(
      input.signal?.aborted
        ? cancelledBy(input.operation, carriedReason(input.signal.reason))
        : regexMatchingDeadlineError(input.operation, deadline),
    );
  const pooled = entry;
  let reusable = false;
  let outcome: Result<readonly number[], AnalysisError>;
  try {
    outcome = await new Promise((resolve) => {
      let settled = false;
      const finish = (result: Result<readonly number[], AnalysisError>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () =>
        finish(
          err(
            cancelledBy(input.operation, carriedReason(input.signal?.reason)),
          ),
        );
      // Queueing for a pooled worker counts toward the caller's deadline.
      const timer = setTimeout(
        () =>
          finish(err(regexMatchingDeadlineError(input.operation, deadline))),
        Math.max(0, deadline.deadlineMs - (performance.now() - startedAt)),
      );
      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
      pooled.onMessage = (message: unknown) => {
        const reply = parseWorkerReply(message, input.values.length);
        switch (reply.kind) {
          case "malformed":
            return finish(
              err(
                new AnalysisOutputError(
                  input.operation,
                  "Regex worker reply is malformed",
                ),
              ),
            );
          case "invalid_pattern":
            reusable = true;
            return finish(
              err(invalidRegexPatternError(input.operation, reply.reason)),
            );
          case "invalid_indices":
            return finish(
              err(
                new AnalysisOutputError(
                  input.operation,
                  "Regex worker returned invalid inventory indices",
                ),
              ),
            );
          case "matched":
            reusable = true;
            return finish(ok(reply.indices));
        }
      };
      pooled.onError = (cause: Error & { code?: string }) =>
        finish(
          err(
            cause.code === "ERR_WORKER_OUT_OF_MEMORY"
              ? regexWorkerHeapError(
                  input.operation,
                  cause,
                  heapForWorkerRequest(heapRequest),
                  heapRequest,
                )
              : new AnalysisOutputError(
                  input.operation,
                  `Regex worker failed: ${cause.message}`,
                  { cause },
                ),
          ),
        );
      pooled.onExit = (code: number) =>
        finish(
          err(
            new AnalysisOutputError(
              input.operation,
              `Regex worker exited without a result (${String(code)})`,
            ),
          ),
        );
      // A worker that failed or is stopping must not run this call's job.
      // A job whose deadline already expired while queueing is not sent either.
      if (
        pooled.exited ||
        pooled.stopping ||
        pooled.stopFailure !== undefined
      ) {
        finish(
          err(
            new AnalysisOutputError(
              input.operation,
              "Regex worker failed before its match started",
              {
                diagnostics: { worker_heap_mib: pooled.heapMiB },
              },
            ),
          ),
        );
      } else if (performance.now() - startedAt >= deadline.deadlineMs) {
        reusable = true;
        finish(err(regexMatchingDeadlineError(input.operation, deadline)));
      } else {
        pooled.worker.postMessage(
          {
            pattern: input.pattern,
            caseSensitive: input.caseSensitive,
            packed: transfer.packed,
          },
          transfer.transferList,
        );
      }
    });
  } catch (cause: unknown) {
    outcome = err(
      new AnalysisOutputError(input.operation, "Regex worker failed", {
        cause,
      }),
    );
  }
  // Clean replies return the worker to the pool. Every other outcome stops
  // that worker and waits until it exits, so close() awaiting this promise
  // does not return while the match is still running. A failed stop keeps
  // the worker counted and leaves the match error as the primary result.
  const canReuse =
    reusable &&
    !pooled.exited &&
    !pooled.stopping &&
    pooled.stopFailure === undefined;
  if (canReuse) {
    releaseRegexWorker(pooled);
    return outcome;
  }
  clearRegexWorkerHandlers(pooled);
  const stopFailure = await ensureRegexWorkerStopped(input.operation, pooled);
  if (stopFailure !== undefined && !outcome.ok)
    outcome.error.retainSecondaryFailure(stopFailure);
  return outcome;
};
