import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  DoctorProviderCheck,
  DoctorProviderInspection,
} from "../application/Doctor.js";
import {
  runUnicornBridge,
  type UnicornBridgeLauncher,
} from "./UnicornBridge.js";
import {
  UNICORN_PROVIDER_IDENTITY,
  UNICORN_PYTHON_ENV_VAR,
  unicornHostSupported,
} from "./UnicornRelease.js";

export interface UnicornDoctorOptions {
  readonly signal?: AbortSignal;
  readonly launcher?: UnicornBridgeLauncher;
  readonly bridgePath?: string;
  /** Test hook: parent directory for per-run directories. */
  readonly runtimeDirBase?: string;
}

const REMEDIATION = `Set ${UNICORN_PYTHON_ENV_VAR} to an absolute caller-supplied Python executable with pwntools 4.15.0, pyelftools 0.33 and Unicorn 2.1.2; REA never installs Python or packages.`;

/**
 * Project Unicorn readiness into the doctor contract without writing
 * anything outside per-run directories (removed afterwards). The version
 * check runs the bridge's probe mode through the same owned-process path
 * the client uses; every failure degrades to a check, never a throw,
 * except caller cancellation.
 */
export const inspectUnicornProvider = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  options: UnicornDoctorOptions = {},
): Promise<DoctorProviderInspection> => {
  const pythonPath = environment[UNICORN_PYTHON_ENV_VAR] ?? "";
  const configured = pythonPath.length > 0;
  const checks: DoctorProviderCheck[] = [];
  let available = true;
  let providerVersion: string | null = null;

  if (!unicornHostSupported(platform, arch)) {
    available = false;
    checks.push({
      name: "host",
      ok: false,
      code: "unsupported_host",
      detail:
        "Unicorn emulation Phase 1 runs on Linux x64 hosts only, inheriting the pwntools lane's verified matrix.",
      remediation: null,
      classification: "unsupported_host",
      details: { platform, arch },
    });
  } else {
    checks.push({
      name: "host",
      ok: true,
      code: null,
      detail: "Linux x64 host.",
      remediation: null,
      classification: "unsupported_host",
      details: { platform, arch },
    });
  }

  if (!configured) {
    available = false;
    checks.push({
      name: "configuration",
      ok: false,
      code: "missing_dependency",
      detail: `${UNICORN_PYTHON_ENV_VAR} is not set.`,
      remediation: REMEDIATION,
      classification: "missing_analysis_engine",
    });
  } else if (!isAbsolute(pythonPath)) {
    available = false;
    checks.push({
      name: "configuration",
      ok: false,
      code: "missing_dependency",
      detail: `${UNICORN_PYTHON_ENV_VAR} must be an absolute path.`,
      remediation: REMEDIATION,
      classification: "config_drift",
      details: { python_path: pythonPath },
    });
  } else {
    checks.push({
      name: "configuration",
      ok: true,
      code: null,
      detail: `${UNICORN_PYTHON_ENV_VAR} is set to an absolute path.`,
      remediation: null,
      classification: "config_drift",
      details: { python_path: pythonPath },
    });
  }

  let executable = false;
  if (configured && isAbsolute(pythonPath)) {
    try {
      await access(pythonPath, constants.X_OK);
      executable = (await stat(pythonPath)).isFile();
    } catch {
      executable = false;
    }
  }
  if (configured && !executable) {
    available = false;
    checks.push({
      name: "python_executable",
      ok: false,
      code: "missing_dependency",
      detail: `Selected Python executable is not an executable regular file: ${pythonPath}`,
      remediation: REMEDIATION,
      classification: "config_drift",
      details: { python_path: pythonPath },
    });
  } else if (configured) {
    checks.push({
      name: "python_executable",
      ok: true,
      code: null,
      detail: "Selected Python executable is present and executable.",
      remediation: null,
      classification: "config_drift",
      details: { python_path: pythonPath },
    });
  }

  if (executable) {
    const bridgePath =
      options.bridgePath ??
      fileURLToPath(
        new URL("../../bridge/unicorn/emulate_function.py", import.meta.url),
      );
    const probe = await runUnicornBridge({
      pythonPath,
      bridgePath,
      request: { probe: true },
      timeoutMs: 10_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.launcher === undefined ? {} : { launcher: options.launcher }),
      ...(options.runtimeDirBase === undefined
        ? {}
        : { runtimeDirBase: options.runtimeDirBase }),
    });
    if (probe.ok && probe.value.ok === true && "probe" in probe.value) {
      providerVersion = probe.value.probe.engine.version;
      checks.push({
        name: "unicorn_importable",
        ok: true,
        code: null,
        detail: `Unicorn ${providerVersion} is importable in the caller-supplied Python.`,
        remediation: null,
        classification: "config_drift",
        details: { unicorn_version: providerVersion },
      });
    } else {
      available = false;
      const detail = !probe.ok
        ? probe.error.message
        : "Unicorn probe returned an unexpected reply.";
      checks.push({
        name: "unicorn_importable",
        ok: false,
        code: "runtime_failure",
        detail,
        remediation: REMEDIATION,
        classification: "runtime_failure",
      });
    }
  }

  return {
    id: UNICORN_PROVIDER_IDENTITY.id,
    configured,
    available,
    providerVersion,
    registrationEnvironment:
      configured && isAbsolute(pythonPath)
        ? { [UNICORN_PYTHON_ENV_VAR]: pythonPath }
        : {},
    checks,
  };
};
