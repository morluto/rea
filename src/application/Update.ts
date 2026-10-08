import { gt, valid } from "semver";

import { PRODUCT_IDENTITY } from "../identity.js";
import type { Result } from "../domain/result.js";
import type { IntegrationMaintenance } from "./UpdateMaintenance.js";

/** Global npm installation that owns the running package and its entry point. */
export interface NpmInstallation {
  readonly prefix: string;
  readonly packageRoot: string;
}

/** Output policy for the package manager subprocess. */
export type UpdateOutput = "human" | "structured";

/** Why release lookup failed before a version could be compared. */
export type ReleaseLookupFailure =
  | { readonly kind: "unavailable"; readonly detail: string }
  | { readonly kind: "invalid-metadata"; readonly detail: string };

/** Effects used to update and verify one identified REA installation. */
export interface UpdateHost {
  installation(): Promise<NpmInstallation | undefined>;
  latestVersion(
    installation: NpmInstallation | undefined,
  ): Promise<Result<string, ReleaseLookupFailure>>;
  installVersion(
    installation: NpmInstallation,
    version: string,
    output: UpdateOutput,
  ): Promise<Result<void, string>>;
  installedVersion(
    installation: NpmInstallation,
  ): Promise<Result<string, string>>;
  planMaintenance(
    installation: NpmInstallation,
  ): Promise<IntegrationMaintenance>;
}

/** Verified update outcome, separate from the unapplied integration plan. */
export type UpdateResult =
  | {
      readonly status: "current";
      readonly currentVersion: string;
      readonly latestVersion: string;
      readonly installMethod: "npm" | "unknown";
    }
  | {
      readonly status: "updated";
      readonly previousVersion: string;
      readonly latestVersion: string;
      readonly installedVersion: string;
      readonly installMethod: "npm";
      readonly command: readonly string[];
      readonly maintenance: IntegrationMaintenance;
      readonly remediation: string;
    }
  | {
      readonly status: "failed";
      readonly currentVersion: string;
      readonly latestVersion: string | null;
      readonly reason:
        | "unknown-install-method"
        | "version-check"
        | "install"
        | "verification";
      readonly installedVersion?: string;
      readonly remediation: string;
    };

/** Whether the update command left the requested release unapplied. */
export const isUpdateFailure = (result: UpdateResult): boolean => {
  const status = result.status;
  switch (status) {
    case "current":
    case "updated":
      return false;
    case "failed":
      return true;
    default: {
      const exhaustive: never = status;
      throw new TypeError(
        `Unhandled update result status: ${String(exhaustive)}`,
      );
    }
  }
};

/** Resolve the exact npm command for the identified prefix and release. */
export const updateInstallCommand = (
  installation: NpmInstallation,
  version: string,
): readonly string[] => [
  "npm",
  "install",
  "--global",
  "--ignore-scripts",
  "--prefix",
  installation.prefix,
  `${PRODUCT_IDENTITY.packageName}@${version}`,
];

const versionCheckRemediation = (
  release: Result<string, ReleaseLookupFailure>,
): string => {
  if (release.ok) {
    return "REA received invalid version metadata. Check the installed version and npm registry, then rerun rea update.";
  }
  const failure = release.error;
  const kind = failure.kind;
  switch (kind) {
    case "unavailable":
      return `REA could not resolve the latest release: ${failure.detail}. Retry rea update when registry access is available.`;
    case "invalid-metadata":
      return `REA could not resolve the latest release: ${failure.detail}. Check the npm release metadata, then rerun rea update.`;
    default: {
      const exhaustive: never = kind;
      throw new TypeError(
        `Unhandled release lookup failure: ${String(exhaustive)}`,
      );
    }
  }
};

/** Identify, resolve, install, and verify REA without applying setup changes. */
export const runUpdate = async (
  currentVersion: string,
  host: UpdateHost,
  output: UpdateOutput = "human",
): Promise<UpdateResult> => {
  const installation = await host.installation();
  const release = await host.latestVersion(installation);
  const latestVersion = release.ok ? release.value : null;
  const targetVersion = release.ok ? valid(release.value) : null;
  if (!release.ok || valid(currentVersion) === null || targetVersion === null)
    return {
      status: "failed",
      currentVersion,
      latestVersion,
      reason: "version-check",
      remediation: versionCheckRemediation(release),
    };
  if (!gt(targetVersion, currentVersion))
    return {
      status: "current",
      currentVersion,
      latestVersion: targetVersion,
      installMethod: installation === undefined ? "unknown" : "npm",
    };
  if (installation === undefined)
    return {
      status: "failed",
      currentVersion,
      latestVersion: targetVersion,
      reason: "unknown-install-method",
      remediation:
        "Update this installation with the package manager or source checkout that owns it. For a one-off latest invocation, use npx rea-agents@latest.",
    };
  const installed = await host.installVersion(
    installation,
    targetVersion,
    output,
  );
  if (!installed.ok)
    return {
      status: "failed",
      currentVersion,
      latestVersion: targetVersion,
      reason: "install",
      remediation: `REA could not install ${targetVersion} in ${installation.prefix}: ${installed.error}. Repair this npm installation, then rerun rea update.`,
    };
  const verified = await host.installedVersion(installation);
  if (!verified.ok || verified.value !== targetVersion)
    return {
      status: "failed",
      currentVersion,
      latestVersion: targetVersion,
      reason: "verification",
      ...(verified.ok ? { installedVersion: verified.value } : {}),
      remediation: `npm completed, but REA could not verify ${targetVersion} in ${installation.packageRoot}: ${verified.ok ? `the executable reported ${verified.value}` : verified.error}. The installation may have changed; repair it before retrying.`,
    };
  const maintenance = await host.planMaintenance(installation);
  return {
    status: "updated",
    previousVersion: currentVersion,
    latestVersion: targetVersion,
    installedVersion: verified.value,
    installMethod: "npm",
    command: updateInstallCommand(installation, targetVersion),
    maintenance,
    remediation:
      maintenance.status === "planned"
        ? "REA is updated. Run the maintenance command to review and approve changes to existing REA integrations, then restart affected agents."
        : maintenance.status === "unavailable"
          ? "REA is updated. Integration maintenance could not be planned; inspect the maintenance diagnostic before changing configuration."
          : "REA is updated. Restart agents running this installation to load the new version.",
  };
};
