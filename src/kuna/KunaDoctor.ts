import { constants } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import { dirname, posix, win32 } from "node:path";

import type {
  DoctorProviderCheck,
  DoctorProviderInspection,
} from "../ports/DoctorProviderInspection.js";
import {
  admitKunaCommand,
  type KunaAdmissionRefusal,
} from "./KunaAdmission.js";
import type { RetainedResourceScope } from "../ports/AnalysisProvider.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import type {
  KunaReadinessFailure,
  KunaResourceScope,
} from "./KunaInstallation.js";
import {
  KUNA_COMMAND_REMEDIATION,
  KUNA_PROVIDER_ID,
  KUNA_UNVERIFIED_VERSION_REMEDIATION,
  KUNA_VERIFIED_VERSION,
  KUNA_VERSION_PROBE_REMEDIATION,
} from "./KunaRelease.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { kunaCacheLocationSettings } from "./KunaConfiguration.js";

/** Settings setup writes into a client registration. */
export const KUNA_REGISTRATION_SETTINGS = [
  "REA_KUNA_COMMAND",
  "REA_KUNA_CACHE_DIR",
  "REA_KUNA_CACHE_MAX_BYTES",
  "REA_KUNA_PROJECT_TIMEOUT_MS",
  "REA_KUNA_TIMEOUT_MS",
  "REA_KUNA_JOBS",
] as const;

// These affect readiness when they select a cache root. Setup leaves them
// inherited by the child process.
const CACHE_FALLBACK_SETTINGS = [
  "HOME",
  "USERPROFILE",
  "XDG_CACHE_HOME",
] as const;

/** Client settings consulted by this readiness probe. */
export const KUNA_DOCTOR_SETTINGS = [
  ...KUNA_REGISTRATION_SETTINGS,
  ...CACHE_FALLBACK_SETTINGS,
] as const;

export const kunaSettingAffectsProbe = (
  name: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): boolean =>
  !CACHE_FALLBACK_SETTINGS.some((setting) => setting === name) ||
  kunaCacheLocationSettings(environment, platform).includes(name);

/**
 * Project Kuna readiness into the doctor contract without writing anything.
 * Readiness is the admission runtime uses (settings and a runnable command),
 * reported as the `installation` check. The `version` probe and the `cache`
 * inspection are health checks reported beside it; they do not decide
 * availability.
 */
export const inspectKunaProvider = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
  options: {
    readonly resourceScope: RetainedResourceScope;
    readonly signal?: AbortSignal;
  },
): Promise<DoctorProviderInspection> => {
  const configured =
    environment.REA_KUNA_COMMAND !== undefined &&
    environment.REA_KUNA_COMMAND.length > 0;
  const admission = admitKunaCommand(environment, platform);
  if (!admission.ok)
    return {
      id: KUNA_PROVIDER_ID,
      configured,
      available: false,
      providerVersion: null,
      registrationEnvironment: {},
      checks: [admissionFailure(admission.error, configured)],
    };
  const { command, cacheRoot, cacheMaxBytes } = admission.value;
  const version = await versionCheck(environment, platform, options);
  return {
    id: KUNA_PROVIDER_ID,
    configured,
    available: true,
    providerVersion: version.version,
    registrationEnvironment: Object.fromEntries(
      KUNA_REGISTRATION_SETTINGS.flatMap((name) => {
        const setting = environment[name];
        return setting === undefined ? [] : [[name, setting]];
      }),
    ),
    checks: [
      {
        name: "installation",
        ok: true,
        code: null,
        detail: `REA_KUNA_COMMAND ${command} is an executable regular file.`,
        remediation: null,
        classification: "config_drift",
        details: { command },
      },
      version.check,
      await cacheCheck(cacheRoot, cacheMaxBytes, platform),
    ],
  };
};

/** Health check: run `kuna --version` and fingerprint the executable. */
const versionCheck = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
  options: {
    readonly resourceScope: RetainedResourceScope;
    readonly signal?: AbortSignal;
  },
): Promise<{
  readonly version: string | null;
  readonly check: DoctorProviderCheck;
}> => {
  const { createKunaResourceScope, inspectKunaInstallation } =
    await import("./KunaInstallation.js");
  const kunaResources = createKunaResourceScope(options.resourceScope);
  let installation: Awaited<ReturnType<typeof inspectKunaInstallation>>;
  try {
    installation = await inspectKunaInstallation(environment, {
      platform,
      resourceScope: kunaResources.owner,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (cause: unknown) {
    const { kunaInstallationDialect } = await import("./KunaCommand.js");
    return {
      version: null,
      check: probeCleanupFailure(cause, kunaResources, kunaInstallationDialect),
    };
  }
  if (!installation.ok) {
    const check = probeFailure(installation.error);
    if (!kunaResources.hasPending) return { version: null, check };
    return {
      version: null,
      check: cleanupIncompleteCheck(
        { ...check, code: "cleanup_incomplete" },
        installation.error.diagnostics,
        kunaResources.cleanupResources,
      ),
    };
  }
  const { value } = installation;
  const versionGuidance = value.verified
    ? null
    : KUNA_UNVERIFIED_VERSION_REMEDIATION;
  return {
    version: value.version,
    check: {
      name: "version",
      ok: true,
      code: null,
      detail: `${value.executable} reports Kuna ${value.version} (sha256 ${value.sha256})${
        value.verified
          ? "."
          : `; REA verified ${KUNA_VERIFIED_VERSION}, so this release's project layout is unverified. ${versionGuidance}`
      }`,
      remediation: versionGuidance,
      classification: "config_drift",
      details: {
        executable: value.executable,
        version: value.version,
        verified_version: KUNA_VERIFIED_VERSION,
        sha256: value.sha256,
      },
    },
  };
};

/** The admission refusal runtime reports, as doctor's readiness check. */
const admissionFailure = (
  refusal: KunaAdmissionRefusal,
  configured: boolean,
): DoctorProviderCheck => ({
  name: "installation",
  ok: false,
  code: refusal.code,
  detail: refusal.reason,
  remediation: refusal.remediation,
  classification:
    refusal.code === "unsupported_host"
      ? "unsupported_host"
      : configured
        ? "config_drift"
        : "missing_analysis_engine",
  details: refusal.diagnostics,
});

/** An installation check whose inspection left cleanup unconfirmed. */
const cleanupIncompleteCheck = (
  check: Omit<DoctorProviderCheck, "details">,
  diagnostics: Readonly<Record<string, JsonValue>> | undefined,
  cleanupResources: readonly string[] | undefined,
): DoctorProviderCheck => ({
  ...check,
  details: {
    ...diagnostics,
    cleanup_incomplete: true,
    ...(cleanupResources === undefined
      ? {}
      : { cleanup_resources: [...cleanupResources] }),
  },
});

/**
 * A probe that threw. The installation dialect owns what an inspection
 * failure means; doctor reports a failure with unconfirmed cleanup and
 * rethrows the rest.
 */
const probeCleanupFailure = (
  cause: unknown,
  kunaResources: KunaResourceScope,
  kunaInstallationDialect: (typeof import("./KunaCommand.js"))["kunaInstallationDialect"],
): DoctorProviderCheck => {
  let recognised = true;
  const failure = classifyProviderFailure(
    cause,
    kunaInstallationDialect("doctor", kunaResources, (unrecognised) => {
      recognised = false;
      return new ProviderAdapterError(KUNA_PROVIDER_ID, "doctor", {
        cause: unrecognised,
      });
    }),
  );
  if (!recognised) throw cause;
  if (!failure.cleanupIncomplete) throw failure;
  return cleanupIncompleteCheck(
    {
      name: "version",
      ok: false,
      code: "cleanup_incomplete",
      detail: `Kuna installation inspection could not confirm cleanup: ${failure.message}`,
      remediation: null,
      classification: "config_drift",
    },
    failure.diagnostics,
    failure.cleanupResources,
  );
};

/** A failed version probe of an admitted command. */
const probeFailure = (failure: KunaReadinessFailure): DoctorProviderCheck => ({
  name: "version",
  ok: false,
  code: failure.code,
  detail: failure.reason,
  remediation:
    failure.remediation ??
    (failure.code === "version_unresolved"
      ? KUNA_VERSION_PROBE_REMEDIATION
      : KUNA_COMMAND_REMEDIATION),
  classification: "config_drift",
  details: failure.diagnostics,
});

/** Health check: the cache root may not exist yet; doctor reports it without creating it. */
const cacheCheck = async (
  cacheRoot: string,
  cacheMaxBytes: number,
  platform: NodeJS.Platform,
): Promise<DoctorProviderCheck> => {
  const details = { cache_root: cacheRoot, cache_max_bytes: cacheMaxBytes };
  // A trailing separator makes lstat follow a dangling link and report ENOENT.
  const inspected = cacheRootWithoutTrailingSeparator(cacheRoot, platform);
  try {
    if (!(await stat(inspected)).isDirectory())
      return {
        name: "cache",
        ok: false,
        code: "open_options_invalid",
        detail: `The Kuna cache root ${cacheRoot} exists but is not a directory.`,
        remediation:
          "Set REA_KUNA_CACHE_DIR to a directory REA may own, or remove the conflicting file.",
        classification: "config_drift",
        details,
      };
    await access(inspected, constants.W_OK | constants.X_OK);
  } catch (cause: unknown) {
    if (isMissing(cause)) {
      const creatable = await nearestDirectoryWritable(inspected);
      return creatable.ok
        ? {
            name: "cache",
            ok: true,
            code: null,
            detail: `REA creates the Kuna project cache at ${cacheRoot} on first use.`,
            remediation: null,
            classification: "config_drift",
            details,
          }
        : {
            name: "cache",
            ok: false,
            code: "open_options_invalid",
            detail: `REA cannot create the Kuna cache root ${cacheRoot}: ${creatable.reason}`,
            remediation:
              "Set REA_KUNA_CACHE_DIR to a directory the REA process user can create or write.",
            classification: "config_drift",
            details,
          };
    }
    return {
      name: "cache",
      ok: false,
      code: "open_options_invalid",
      detail: `REA cannot write the Kuna cache root ${cacheRoot}: ${errorMessage(cause)}`,
      remediation:
        "Set REA_KUNA_CACHE_DIR to a directory the REA process user can write.",
      classification: "config_drift",
      details,
    };
  }
  return {
    name: "cache",
    ok: true,
    code: null,
    detail: `Kuna project exports are cached in ${cacheRoot} (at most ${String(cacheMaxBytes)} bytes).`,
    remediation: null,
    classification: "config_drift",
    details,
  };
};

/**
 * Whether the nearest existing entry on `path` is a directory REA may create
 * entries in. A missing target is only absent when no entry occupies its name;
 * a dangling symbolic link blocks creation just as a regular file does.
 * `path` must not end in a separator, or lstat follows a dangling link.
 */
const nearestDirectoryWritable = async (
  path: string,
): Promise<
  { readonly ok: true } | { readonly ok: false; readonly reason: string }
> => {
  let candidate = path;
  for (;;) {
    try {
      if (!(await stat(candidate)).isDirectory())
        return { ok: false, reason: `${candidate} is not a directory.` };
      await access(candidate, constants.W_OK | constants.X_OK);
      return { ok: true };
    } catch (cause: unknown) {
      const parent = dirname(candidate);
      const absent = isMissing(cause) ? await entryAbsent(candidate) : false;
      if (absent !== true || parent === candidate)
        return {
          ok: false,
          reason:
            typeof absent === "string"
              ? absent
              : `${candidate} is not writable: ${errorMessage(cause)}`,
        };
      candidate = parent;
    }
  }
};

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

/** True when nothing occupies `path`; otherwise why its name is unusable. */
const entryAbsent = async (path: string): Promise<true | string> => {
  try {
    return (await lstat(path)).isSymbolicLink()
      ? `${path} is a symbolic link whose target does not exist.`
      : `${path} exists but cannot be resolved.`;
  } catch (cause: unknown) {
    return isMissing(cause)
      ? true
      : `${path} cannot be inspected: ${errorMessage(cause)}`;
  }
};

/**
 * Drop a terminal separator without turning a filesystem root into its parent.
 * On Darwin and Linux, `\` is a filename character, so only `/` is removed.
 */
const cacheRootWithoutTrailingSeparator = (
  cacheRoot: string,
  platform: NodeJS.Platform,
): string => {
  const pathApi = platform === "win32" ? win32 : posix;
  const root = pathApi.parse(cacheRoot).root;
  const separator = pathApi.sep.charCodeAt(0);
  let end = cacheRoot.length;
  while (end > root.length && cacheRoot.charCodeAt(end - 1) === separator)
    end -= 1;
  return end === cacheRoot.length ? cacheRoot : cacheRoot.slice(0, end);
};
