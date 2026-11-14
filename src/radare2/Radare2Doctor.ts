import type {
  DoctorProviderCheck,
  DoctorProviderInspection,
} from "../application/Doctor.js";
import { resolveProviderExecutable } from "../process/resolveWindowsProviderExecutable.js";
import {
  execFileOutput,
  execFileOutputFailure,
} from "../process/ExecFileOutput.js";

const VERSION_TIMEOUT_MS = 10_000;
/** r2pipe2 replies (`{"cmd":…}`) ship with radare2 5.9. */
const R2PIPE2_FLOOR = { major: 5, minor: 9 };

/** Registration settings read by the radare2 readiness probe. */
export const RADARE2_DOCTOR_SETTINGS = ["REA_R2_COMMAND"] as const;

/** @internal Pure parser kept separately testable from process execution. */
export const parseRadare2Version = (output: string): string | null => {
  const match = /\bradare2\s+(\d+)\.(\d+)\.(\d+)/u.exec(output);
  return match === null ? null : `${match[1]}.${match[2]}.${match[3]}`;
};

interface VersionOutcome {
  readonly ok: boolean;
  readonly code?: string;
  readonly stdout?: string;
}

/** Inspect the BYO radare2 executable for `rea doctor` without installing it. */
export const inspectRadare2Provider = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  options: {
    /** @internal Test seam; production callers run the real executable. */
    readonly runVersion?: (command: string) => Promise<VersionOutcome>;
    /** Doctor inspection cancellation; a stopped probe still settles after exit. */
    readonly signal?: AbortSignal;
  } = {},
): Promise<DoctorProviderInspection> => {
  // Resolve the same way the one-shot and session paths spawn the engine, so
  // the doctor's availability verdict matches what actually runs.
  const command = resolveProviderExecutable(
    environment.REA_R2_COMMAND ?? "radare2",
    environment,
    process.platform,
  );
  const runVersion =
    options.runVersion ??
    (async (selected: string) => {
      try {
        const { stdout } = await execFileOutput(selected, ["-version"], {
          timeout: VERSION_TIMEOUT_MS,
          env: { ...environment },
          stopSignal: "SIGTERM",
          maxBuffer: 64 * 1024,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        return { ok: true, stdout };
      } catch (cause) {
        const code = execFileOutputFailure(cause)?.code;
        return {
          ok: false,
          code:
            typeof code === "string"
              ? code
              : code === null || code === undefined
                ? "runtime_failure"
                : String(code),
        };
      }
    });
  const outcome = await runVersion(command);
  if (!outcome.ok) {
    const missing = outcome.code === "ENOENT";
    const check: DoctorProviderCheck = {
      name: "radare2-executable",
      ok: false,
      code: outcome.code ?? null,
      detail: `Unable to run ${command} -version.`,
      remediation: missing
        ? `Install radare2 (or point REA_R2_COMMAND at your executable); REA never installs it. Session tools additionally need radare2 >= ${R2PIPE2_FLOOR.major}.${R2PIPE2_FLOOR.minor}.`
        : `Inspect why ${command} -version fails, then rerun rea doctor.`,
      classification: missing ? "missing_dependency" : "runtime_failure",
    };
    return {
      id: "radare2",
      configured: environment.REA_R2_COMMAND !== undefined,
      available: false,
      providerVersion: null,
      registrationEnvironment: {},
      checks: [check],
    };
  }
  const version = parseRadare2Version(outcome.stdout ?? "");
  const floorFailure =
    version === null
      ? "The version output was not recognized; provider version remains unknown."
      : satisfiesR2Pipe2(version)
        ? null
        : `radare2 ${version} predates the r2pipe2 protocol (>= ${R2PIPE2_FLOOR.major}.${R2PIPE2_FLOOR.minor}); session tools are unavailable, one-shot commands still work.`;
  return {
    id: "radare2",
    configured: environment.REA_R2_COMMAND !== undefined,
    available: true,
    providerVersion: version,
    registrationEnvironment: {},
    checks:
      floorFailure === null
        ? []
        : [
            {
              name: "radare2-r2pipe2",
              ok: false,
              code: "version_below_r2pipe2_floor",
              detail: floorFailure,
              remediation: `Upgrade radare2 to ${R2PIPE2_FLOOR.major}.${R2PIPE2_FLOOR.minor} or newer to use start_radare2_session and radare2_command.`,
              classification: "config_drift",
            },
          ],
  };
};

const satisfiesR2Pipe2 = (version: string): boolean => {
  const [major, minor] = version.split(".").map(Number);
  if (major === undefined || minor === undefined) return false;
  if (major !== R2PIPE2_FLOOR.major) return major > R2PIPE2_FLOOR.major;
  return minor >= R2PIPE2_FLOOR.minor;
};
