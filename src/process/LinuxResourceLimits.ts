import { ProcessAdmissionError } from "./ProcessAdmissionError.js";
import { open } from "node:fs/promises";
import { readFileHandleRange } from "../filesystem/readFileHandleRange.js";
import { errorMessage } from "../kernel/errorMessage.js";
import {
  assertArtifactReadActive,
  withArtifactFileHandle,
  type ArtifactResourceScope,
} from "../resources/index.js";

/** Per-process ceilings inherited by an owned Linux producer. */
export interface LinuxResourceLimits {
  readonly address_space_bytes: number;
  readonly file_bytes: number;
  readonly cpu_seconds: number;
}
const rows = {
  address_space_bytes: { name: "Max address space", unit: "bytes" },
  file_bytes: { name: "Max file size", unit: "bytes" },
  cpu_seconds: { name: "Max cpu time", unit: "seconds" },
} as const;
const REPORT_PATH = "/proc/self/limits";
const REPORT_BUDGET = 16 * 1024;

type LimitKey = keyof LinuxResourceLimits;
type KernelLimit = bigint | "unlimited";

const kernelLimit = (token: string | undefined): KernelLimit | undefined =>
  token === "unlimited"
    ? token
    : token !== undefined && /^[0-9]+$/u.test(token)
      ? BigInt(token)
      : undefined;

const readRow = (
  lines: readonly string[],
  limit: LimitKey,
): { readonly soft: KernelLimit; readonly hard: KernelLimit } => {
  const { name, unit } = rows[limit];
  const matches = lines.filter((line) => line.startsWith(`${name} `));
  const match = matches[0];
  if (matches.length !== 1 || match === undefined)
    throw new ProcessAdmissionError("limit_unreadable", { limit, name });
  const [softToken, hardToken, observedUnit, ...extra] = match
    .slice(name.length)
    .trim()
    .split(/\s+/u);
  const soft = kernelLimit(softToken);
  const hard = kernelLimit(hardToken);
  if (
    soft === undefined ||
    hard === undefined ||
    observedUnit !== unit ||
    extra.length > 0
  )
    throw new ProcessAdmissionError("limit_invalid", { limit, name });
  if (hard !== "unlimited" && (soft === "unlimited" || soft > hard))
    throw new ProcessAdmissionError("limit_invalid", {
      limit,
      name,
      violation: "soft_exceeds_hard",
    });
  return { soft, hard };
};

/** Describe a typed report refusal or its physical I/O failure. */
export const describeLinuxResourceLimitsFailure = (cause: unknown): string => {
  if (cause instanceof ProcessAdmissionError) {
    const name = cause.detail?.name;
    if (cause.code === "limit_unreadable")
      return `Linux resource limits must report exactly one ${String(name)} row.`;
    if (cause.code === "limit_invalid")
      return cause.detail?.violation === "soft_exceeds_hard"
        ? `Inherited ${String(name)} soft limit exceeds its hard limit.`
        : `Malformed inherited Linux resource limit: ${String(name)}.`;
    if (cause.code === "report_exceeds_budget")
      return `Inherited Linux resource limits at ${REPORT_PATH} could not be read within the ${String(REPORT_BUDGET)}-byte budget.`;
  }
  return `Could not read inherited Linux resource limits at ${REPORT_PATH}: ${errorMessage(cause)}`;
};

/**
 * Pin soft and hard ceilings together, ending at the prlimit option terminator.
 * Callers that append the producer command themselves use this prefix.
 */
export const prlimitCeilingArguments = (
  limits: LinuxResourceLimits,
): string[] => [
  `--as=${limits.address_space_bytes}:${limits.address_space_bytes}`,
  `--fsize=${limits.file_bytes}:${limits.file_bytes}`,
  `--cpu=${limits.cpu_seconds}:${limits.cpu_seconds}`,
  "--core=0:0",
  "--",
];

/** Pin soft and hard ceilings together, then hand the producer argv to the limiter. */
export const prlimitArgumentVector = (
  limits: LinuxResourceLimits,
  command: string,
): string[] => [...prlimitCeilingArguments(limits), command];

/** Never raise either inherited soft policy or hard ceiling. */
export const clampLinuxResourceLimits = (
  configured: LinuxResourceLimits,
  report: string,
): LinuxResourceLimits => {
  const effective = { ...configured };
  const lines = report.split("\n");
  for (const key of Object.keys(rows) as LimitKey[]) {
    const { soft, hard } = readRow(lines, key);
    let ceiling = BigInt(configured[key]);
    for (const value of [soft, hard])
      if (value !== "unlimited" && value < ceiling) ceiling = value;
    effective[key] = Number(ceiling);
  }
  return effective;
};

/** Read the trusted kernel report with a fixed allocation before spawning. */
export const readLinuxResourceLimits = async (
  configured: LinuxResourceLimits,
  resourceScope?: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<LinuxResourceLimits> => {
  assertArtifactReadActive(signal);
  const file = await open(REPORT_PATH, "r");
  return withArtifactFileHandle(
    REPORT_PATH,
    file,
    resourceScope,
    signal,
    async (handle) => {
      const buffer = await readFileHandleRange(handle, 0, REPORT_BUDGET);
      if (buffer.length === REPORT_BUDGET)
        throw new ProcessAdmissionError("report_exceeds_budget", {
          budget_bytes: REPORT_BUDGET,
        });
      return clampLinuxResourceLimits(configured, buffer.toString("utf8"));
    },
  );
};
