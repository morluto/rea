import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { MAX_NODE_TIMER_DELAY_MS } from "../domain/analysisResourceLimits.js";
import { posixPathCandidates } from "../process/executableSearch.js";

import type { ProviderAvailability } from "../ports/AnalysisProvider.js";

/** Resolved Leandec connection; every field comes from the caller's environment. */
export interface LeandecSettings {
  readonly python: string;
  readonly server: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly defaultTimeoutMs: number;
  readonly importTimeoutMs: number;
  readonly inventoryLimit: number;
  readonly stringLimit: number;
  readonly autoAnalyze: boolean;
  readonly serverVersion: string;
}

export type LeandecSettingsResolution =
  | { readonly ok: true; readonly settings: LeandecSettings }
  | {
      readonly ok: false;
      readonly code:
        | "not_configured"
        | "executable_missing"
        | "runtime_missing"
        | "open_options_invalid";
      readonly reason: string;
    };

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_IMPORT_TIMEOUT_MS = 3_600_000;
const DEFAULT_INVENTORY_LIMIT = 50_000;
const DEFAULT_STRING_LIMIT = 20_000;

const integer = (
  raw: string | undefined,
  fallback: number,
): number | undefined => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return /^[0-9]+$/u.test(raw) &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_NODE_TIMER_DELAY_MS
    ? value
    : undefined;
};

/** Read SERVER_VERSION from the script so the profile reflects the real server. */
const serverVersionOf = (server: string): string => {
  try {
    const source = readFileSync(server, "utf8");
    const match = /SERVER_VERSION\s*=\s*"([^"]+)"/u.exec(source);
    return match?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
};

/**
 * Resolve the Leandec MCP server from the environment. Nothing here starts a
 * process or reads the Leandec cache, so discovery stays side-effect free.
 */
export const resolveLeandecSettings = (
  environment: Readonly<Record<string, string | undefined>>,
): LeandecSettingsResolution => {
  const configured = environment.LEANDEC_MCP_SERVER?.trim();
  if (configured === undefined || configured.length === 0)
    return {
      ok: false,
      code: "not_configured",
      reason:
        "Set LEANDEC_MCP_SERVER to the absolute path of Leandec's mcp_server.py to enable the Leandec provider.",
    };
  const server = isAbsolute(configured) ? configured : resolve(configured);
  try {
    if (!statSync(server).isFile()) throw new TypeError("not a file");
    accessSync(server, constants.R_OK);
  } catch {
    return {
      ok: false,
      code: "executable_missing",
      reason: `LEANDEC_MCP_SERVER does not name a readable file: ${server}`,
    };
  }
  const requestedPython = environment.LEANDEC_PYTHON?.trim() || "python3";
  const candidates =
    requestedPython.includes("/") || isAbsolute(requestedPython)
      ? [resolve(dirname(server), requestedPython)]
      : Array.from(
          posixPathCandidates(
            requestedPython,
            environment.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            { relativeEntries: "resolve", workingDirectory: dirname(server) },
          ),
          (candidate) => candidate.path,
        );
  const python = candidates.find((candidate) => {
    try {
      if (!statSync(candidate).isFile()) return false;
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (python === undefined)
    return {
      ok: false,
      code: "runtime_missing",
      reason: `Python interpreter is not executable: ${requestedPython}`,
    };
  const defaultTimeoutMs = integer(
    environment.LEANDEC_CALL_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );
  const importTimeoutMs = integer(
    environment.LEANDEC_IMPORT_TIMEOUT_MS,
    DEFAULT_IMPORT_TIMEOUT_MS,
  );
  const inventoryLimit = integer(
    environment.LEANDEC_INVENTORY_LIMIT,
    DEFAULT_INVENTORY_LIMIT,
  );
  const stringLimit = integer(
    environment.LEANDEC_STRING_LIMIT,
    DEFAULT_STRING_LIMIT,
  );
  if (
    defaultTimeoutMs === undefined ||
    importTimeoutMs === undefined ||
    inventoryLimit === undefined ||
    stringLimit === undefined ||
    (environment.LEANDEC_AUTO_ANALYZE !== undefined &&
      !["0", "1"].includes(environment.LEANDEC_AUTO_ANALYZE))
  )
    return {
      ok: false,
      code: "open_options_invalid",
      reason: `LEANDEC_CALL_TIMEOUT_MS, LEANDEC_IMPORT_TIMEOUT_MS, LEANDEC_INVENTORY_LIMIT and LEANDEC_STRING_LIMIT must be decimal integers between 1 and ${String(MAX_NODE_TIMER_DELAY_MS)}; LEANDEC_AUTO_ANALYZE must be 0 or 1.`,
    };
  return {
    ok: true,
    settings: {
      python,
      server,
      cwd: dirname(server),
      environment,
      defaultTimeoutMs,
      importTimeoutMs,
      inventoryLimit,
      stringLimit,
      autoAnalyze: environment.LEANDEC_AUTO_ANALYZE !== "0",
      serverVersion: serverVersionOf(server),
    },
  };
};

/** Project a settings resolution into one provider availability observation. */
export const leandecAvailability = (
  resolution: LeandecSettingsResolution,
  platform: NodeJS.Platform,
): ProviderAvailability => {
  if (!resolution.ok)
    return {
      status: "unavailable",
      code: resolution.code,
      reason: resolution.reason,
      remediation:
        "Configure a readable LEANDEC_MCP_SERVER and executable LEANDEC_PYTHON.",
      diagnostics: { platform },
    };
  if (platform === "win32")
    return {
      status: "unavailable",
      code: "unsupported_host",
      reason:
        "Leandec's MCP server is developed and tested on macOS and Linux; Windows is not supported by this adapter.",
      remediation: "Use a supported macOS or Linux host.",
      diagnostics: { platform, server: resolution.settings.server },
    };
  return {
    status: "available",
    code: null,
    reason: null,
    diagnostics: {
      platform,
      server: resolution.settings.server,
      python: resolution.settings.python,
      server_version: resolution.settings.serverVersion,
      auto_analyze: resolution.settings.autoAnalyze,
    },
  };
};
