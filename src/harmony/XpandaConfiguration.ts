import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { err, ok, type Result } from "../domain/result.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import {
  XPANDA_ADMITTED_MAJOR_VERSION,
  XPANDA_CHECKOUT_REMEDIATION,
  XPANDA_ROOT_REMEDIATION,
  XPANDA_ROOT_VARIABLE,
  XPANDA_UNSUPPORTED_HOST_REMEDIATION,
  XPANDA_VERSION_REMEDIATION,
  XPANDA_VERIFIED_VERSION,
} from "./XpandaRelease.js";
import { errorMessage } from "../kernel/errorMessage.js";

/** Caller-supplied xpanda bridge inputs, resolved only when an operation is selected. */
export interface XpandaConfiguration {
  /** Absolute, symlink-resolved checkout root. */
  readonly root: string;
  /** Absolute MCP server entry the bridge launches. */
  readonly serverEntry: string;
  /** Producer package version declared by the checkout. */
  readonly version: string;
}

type ConfigurationFailureCode =
  | "not_configured"
  | "unsupported_host"
  | "checkout_invalid"
  | "version_unresolved"
  | "version_unsupported";

/** One tagged configuration failure; consumers project remediation from the code. */
export interface XpandaConfigurationFailure {
  readonly code: ConfigurationFailureCode;
  readonly reason: string;
  readonly remediation: string;
}

const failure = (
  code: ConfigurationFailureCode,
  reason: string,
): Result<never, XpandaConfigurationFailure> =>
  err({
    code,
    reason,
    remediation:
      code === "not_configured"
        ? XPANDA_ROOT_REMEDIATION
        : code === "unsupported_host"
          ? XPANDA_UNSUPPORTED_HOST_REMEDIATION
          : code === "version_unresolved" || code === "version_unsupported"
            ? XPANDA_VERSION_REMEDIATION
            : XPANDA_CHECKOUT_REMEDIATION,
  });

/** Parse the producer package version; admits 2.x and records the exact value. */
export const admitXpandaVersion = (
  version: unknown,
):
  | { readonly status: "admitted"; readonly version: string }
  | { readonly status: "unresolved"; readonly reason: string }
  | { readonly status: "unsupported"; readonly reason: string } => {
  if (
    typeof version !== "string" ||
    version.length === 0 ||
    version.length > 64
  )
    return {
      status: "unresolved",
      reason:
        "The configured xpanda checkout has no usable package.json version.",
    };
  const major = Number.parseInt(version.match(/^\d+/u)?.[0] ?? "", 10);
  if (!Number.isInteger(major))
    return {
      status: "unresolved",
      reason: `The configured xpanda checkout reports the non-numeric version ${version}.`,
    };
  if (major !== XPANDA_ADMITTED_MAJOR_VERSION)
    return {
      status: "unsupported",
      reason: `The configured xpanda checkout reports ${version}; REA verified ${XPANDA_VERIFIED_VERSION} and admits ${String(XPANDA_ADMITTED_MAJOR_VERSION)}.x only.`,
    };
  return { status: "admitted", version };
};

/** Manifest reads are bounded; a package.json never needs to be large. */
const XPANDA_MANIFEST_READ_BOUND_BYTES = 1024 * 1024;

/** Read the package version without starting any process. */
const readXpandaVersion = async (
  root: string,
  signal?: AbortSignal,
): Promise<Result<string, XpandaConfigurationFailure>> => {
  const manifestPath = join(root, "package.json");
  signal?.throwIfAborted();
  let manifest: unknown;
  try {
    const text = await readFile(manifestPath, {
      encoding: "utf8",
      ...(signal === undefined ? {} : { signal }),
    });
    if (Buffer.byteLength(text) > XPANDA_MANIFEST_READ_BOUND_BYTES)
      throw new Error(
        `package.json exceeds the ${String(XPANDA_MANIFEST_READ_BOUND_BYTES)}-byte read bound`,
      );
    manifest = JSON.parse(text);
  } catch (cause: unknown) {
    signal?.throwIfAborted();
    return failure(
      "checkout_invalid",
      `The configured xpanda checkout has no readable package.json at ${manifestPath}: ${errorMessage(cause)}`,
    );
  }
  const admitted = admitXpandaVersion(
    (manifest as { version?: unknown } | null)?.version,
  );
  if (admitted.status === "unresolved")
    return failure("version_unresolved", admitted.reason);
  if (admitted.status === "unsupported")
    return failure("version_unsupported", admitted.reason);
  return ok(admitted.version);
};

/** Verify the checkout layout without starting any process. */
const inspectXpandaCheckoutLayout = async (
  root: string,
): Promise<Result<void, XpandaConfigurationFailure>> => {
  const serverEntry = join(root, "src", "mcp", "server.ts");
  try {
    if (!(await stat(serverEntry)).isFile())
      return failure(
        "checkout_invalid",
        `${serverEntry} is not a regular file.`,
      );
  } catch (cause: unknown) {
    return failure(
      "checkout_invalid",
      `The configured xpanda checkout is missing src/mcp/server.ts: ${errorMessage(cause)}`,
    );
  }
  try {
    await access(
      join(root, "node_modules", "tsx", "package.json"),
      constants.R_OK,
    );
  } catch (cause: unknown) {
    return failure(
      "checkout_invalid",
      `The configured xpanda checkout has no readable tsx loader under node_modules: ${errorMessage(cause)}`,
    );
  }
  return ok(undefined);
};

/** Resolve the caller-supplied checkout without probing any runtime behavior. */
export const resolveXpandaConfiguration = async (
  environment: Readonly<Record<string, string | undefined>>,
  options: {
    readonly signal?: AbortSignal;
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<Result<XpandaConfiguration, XpandaConfigurationFailure>> => {
  const { signal } = options;
  const platform = options.platform ?? HOST_PLATFORM.platform;
  signal?.throwIfAborted();
  if (platform !== "linux" && platform !== "darwin")
    return failure(
      "unsupported_host",
      `The xpanda provider requires Linux or macOS; ${platform} process-tree ownership is not verified.`,
    );
  const configured = environment[XPANDA_ROOT_VARIABLE];
  if (configured === undefined || configured.length === 0)
    return failure(
      "not_configured",
      `${XPANDA_ROOT_VARIABLE} is not set to an absolute xpanda checkout path.`,
    );
  if (!isAbsolute(configured))
    return failure(
      "not_configured",
      `${XPANDA_ROOT_VARIABLE} must be an absolute path; got ${configured}.`,
    );
  let root: string;
  try {
    root = await realpath(configured);
  } catch (cause: unknown) {
    return failure(
      "checkout_invalid",
      `${XPANDA_ROOT_VARIABLE} is unavailable: ${errorMessage(cause)}`,
    );
  }
  const layout = await inspectXpandaCheckoutLayout(root);
  if (!layout.ok) return layout;
  signal?.throwIfAborted();
  const version = await readXpandaVersion(root, signal);
  if (!version.ok) return version;
  return ok({
    root,
    serverEntry: join(root, "src", "mcp", "server.ts"),
    version: version.value,
  });
};

/** Host observation made without starting the bridge process. */
export type XpandaAvailability =
  | {
      readonly status: "available";
      readonly reason: null;
      readonly version: string;
    }
  | {
      readonly status: "unavailable";
      readonly code: ConfigurationFailureCode;
      readonly reason: string;
    };

/** Cheap availability probe; starts no process and reads only the checkout. */
export const inspectXpandaAvailability = async (
  environment: Readonly<Record<string, string | undefined>>,
): Promise<XpandaAvailability> => {
  const resolved = await resolveXpandaConfiguration(environment);
  if (!resolved.ok)
    return {
      status: "unavailable",
      code: resolved.error.code,
      reason: resolved.error.reason,
    };
  return {
    status: "available",
    reason: null,
    version: resolved.value.version,
  };
};
