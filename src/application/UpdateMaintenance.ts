import { sameClientConfigurationFile } from "./ClientConfigPath.js";
import { z } from "zod";
import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";

import { currentClientRegistrationCommand } from "./ClientRegistrationIdentity.js";
import {
  readClientRegistrationInspections,
  type ClientRegistrationStatus,
} from "./ClientRegistrationStatus.js";
import { clientRefreshRefusal } from "./SetupClientConfiguration.js";
import { explicitSetupRegistrationEnvironment } from "./SetupRegistrationEnvironment.js";
import {
  existingSkillDestinations,
  type SkillPathIssue,
} from "./SetupSkill.js";
import type { SetupAction } from "./SetupTypes.js";
import type { Result } from "../domain/result.js";
import type { ArtifactResourceScope } from "../resources/index.js";
import {
  supportedClients,
  type ClientSystemPaths,
} from "./SupportedClients.js";
import { errorMessage } from "../kernel/errorMessage.js";

/**
 * A client maintenance left alone: its registration as inspected, and why REA
 * cannot update it (unresolved identity, or setup's preflight refusal).
 */
export type UnresolvedMaintenanceClient = Pick<
  ClientRegistrationStatus,
  "client" | "config_path" | "state"
> & { readonly remediation: string };

/** Existing REA integrations selected for maintenance, without discovering new targets. */
export interface MaintenanceScope {
  readonly clients: readonly string[];
  readonly skill: boolean;
  readonly unresolved?: readonly UnresolvedMaintenanceClient[];
  readonly skillIssues?: readonly SkillPathIssue[];
  readonly skillDestinations?: readonly {
    readonly client: string;
    readonly path: string;
  }[];
}

/** Unapplied maintenance evidence produced by the updated setup executable. */
export type IntegrationMaintenance =
  | {
      readonly status: "current";
      readonly plannedActions: readonly [];
      /** Clients left unmaintained because REA cannot identify or update their registration. */
      readonly unresolved?: readonly UnresolvedMaintenanceClient[];
    }
  | {
      readonly status: "planned";
      readonly scope: MaintenanceScope;
      readonly command: readonly string[];
      readonly plannedActions: readonly SetupAction[];
    }
  | {
      readonly status: "unavailable";
      readonly remediation: string;
      readonly scope?: MaintenanceScope;
    };

const setupPlanSchema = z.object({
  status: z.literal("planned"),
  plannedActions: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["configure_client", "install_skill"]),
      label: z.string(),
      target: z.string(),
      detail: z.string(),
      external: z.literal(false),
      operation: z.enum(["create", "update", "install"]),
      backupPath: z.string().optional(),
      commands: z.array(z.string()).optional(),
    }),
  ),
});

const unresolvedRegistrationDetail = ({
  client,
  config_path,
  remediation,
}: UnresolvedMaintenanceClient): string =>
  `${client} (${config_path}): ${remediation}`;

/** Clients a maintenance result left alone because REA cannot identify or update their registration. */
export const unresolvedMaintenanceClients = (
  maintenance: IntegrationMaintenance,
): readonly UnresolvedMaintenanceClient[] =>
  (maintenance.status === "current"
    ? maintenance.unresolved
    : maintenance.scope?.unresolved) ?? [];

/** One sentence naming each unknown client and its own recovery. */
export const unresolvedMaintenanceRemediation = (
  unresolved: readonly UnresolvedMaintenanceClient[],
): string =>
  `REA did not maintain ${unresolved.length === 1 ? "one client" : `${String(unresolved.length)} clients`} whose registration it cannot update: ${unresolved.map(unresolvedRegistrationDetail).join(" ")}`;

/** A maintenance failure that still reports the unknown clients it found. */
const unavailableMaintenance = (
  remediation: string,
  scope: MaintenanceScope | undefined,
): IntegrationMaintenance => {
  const unresolved = scope?.unresolved ?? [];
  return {
    status: "unavailable",
    remediation:
      unresolved.length === 0
        ? remediation
        : `${remediation} ${unresolvedMaintenanceRemediation(unresolved)}`,
    ...(scope === undefined ? {} : { scope }),
  };
};

/** Why update leaves a stale entry MiMo Code imports from a file Claude Code's row does not read. */
const unmaintainedImportRemediation = (
  { client, config_path }: ClientRegistrationStatus,
  claudeCodePath: string | undefined,
): string =>
  `MiMo Code imports this rea entry from ${config_path}, which update does not refresh${claudeCodePath === undefined ? "" : ` because REA maintains Claude Code's registration in ${claudeCodePath}`}. Run rea setup --client ${client} to give MiMo Code its own entry.`;

/** Where maintenance reads: the caller's resource scope and system layers. */
export interface MaintenanceInputs {
  /** The platform whose client layout and environment identity apply. */
  readonly platform: NodeJS.Platform;
  readonly resources?: ArtifactResourceScope;
  /** System configuration files; tests point them inside their own home. */
  readonly systemPaths?: ClientSystemPaths;
}

/** Discover owned registrations and REA skills without writes. */
export const existingMaintenanceScope = async (
  home: string,
  entryPoint: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  { platform, resources, systemPaths }: MaintenanceInputs,
): Promise<MaintenanceScope> => {
  const registrations = await readClientRegistrationInspections(
    home,
    entryPoint,
    {
      platform,
      environment,
      // A registration REA wrote must be refreshed even when the product
      // profile is absent, so maintenance reads ownership evidence instead of
      // product applicability. Owned rows stay the only ones selected below.
      evidence: "ownership",
      scope: "user",
      ...(resources === undefined ? {} : { resources }),
      ...(systemPaths === undefined ? {} : { systemPaths }),
    },
  );
  const clients: string[] = [];
  const unresolved: UnresolvedMaintenanceClient[] = [];
  // The launcher and explicitly selected settings the maintenance setup run
  // registers; provider defaults doctor discovers there are not known here.
  const command = currentClientRegistrationCommand({
    platform,
    entrypointPath: entryPoint,
    environment,
  });
  const settings = explicitSetupRegistrationEnvironment(environment);
  for (const {
    status: registration,
    activation,
    client,
    importedFrom,
  } of registrations) {
    if (registration.state === "unknown" || registration.state === "invalid") {
      unresolved.push(registration);
      continue;
    }
    if (
      activation !== "enabled" ||
      (registration.state !== "aligned" && registration.state !== "stale") ||
      registration.command_identity !== "owned"
    )
      continue;
    // Setup here would add MiMo Code's own entry instead, so an imported entry
    // follows Claude Code's refresh, which reaches it only when Claude Code's
    // row reads that same file.
    if (importedFrom !== undefined) {
      const source = supportedClients(
        home,
        platform,
        environment,
        systemPaths,
      ).find(({ name }) => name === importedFrom)?.configPath;
      if (
        registration.state === "stale" &&
        (source === undefined ||
          !(await sameClientConfigurationFile(
            source,
            registration.config_path,
          )))
      )
        unresolved.push({
          ...registration,
          remediation: unmaintainedImportRemediation(registration, source),
        });
      continue;
    }
    // One client setup refuses (a client policy, or a read-only inline layer
    // that would override the refreshed entry) blocks the whole setup plan,
    // so ask setup's own refusal check first and report that client instead
    // of selecting it. An aligned registration is checked too: setup still
    // preflights it. When the conflict involves only provider settings setup
    // discovers, alignment is unknown here, not aligned or refused.
    const refusal = await clientRefreshRefusal(client, settings, command, {
      platform,
      currentCommandPath: entryPoint,
      launcherEnvironment: environment,
      ...(resources === undefined ? {} : { resources }),
    });
    if (refusal !== undefined) {
      unresolved.push({
        ...registration,
        ...(refusal.alignment === "unknown" ? { state: "unknown" } : {}),
        remediation: refusal.remediation,
      });
      continue;
    }
    clients.push(registration.client);
  }
  // Each setup action rewrites only that client's own configuration path, so
  // maintenance keeps every selected client instead of deferring one view of
  // a registration to another client's inspection: ZCode writes
  // ~/.zcode/cli/config.json and deliberately leaves the ~/.agents/mcp.json
  // fallback untouched (docs/getting-started/client-configuration.md), while FreeBuff writes
  // the shared file itself. Dropping FreeBuff because ZCode reads that
  // fallback would leave the row both products load pinned to the old
  // version.
  const skills = await existingSkillDestinations(
    home,
    environment,
    platform,
    resources,
  );
  return {
    clients,
    skill: skills.destinations.length > 0,
    skillDestinations: skills.destinations,
    ...(skills.issues.length === 0 ? {} : { skillIssues: skills.issues }),
    ...(unresolved.length === 0 ? {} : { unresolved }),
  };
};

/** Ask the verified new executable to plan only existing REA integrations. */
export const planIntegrationMaintenance = async (
  home: string,
  entryPoint: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  execute: (command: readonly string[]) => Promise<Result<string, string>>,
  inputs: MaintenanceInputs,
): Promise<IntegrationMaintenance> => {
  const { resources } = inputs;
  let scope: MaintenanceScope | undefined;
  try {
    scope = await existingMaintenanceScope(
      home,
      entryPoint,
      environment,
      inputs,
    );
    // An unresolved client fails closed on its own: it stays out of the
    // maintained clients and is reported, while every resolved client is
    // still maintained. Skill destinations are one shared selection.
    if ((scope.skillIssues?.length ?? 0) > 0)
      return unavailableMaintenance(
        `Integration maintenance is unresolved: ${(scope.skillIssues ?? [])
          .map(
            ({ client, path, detail }) =>
              `${client ?? "skill"} (${path}): ${detail}`,
          )
          .join(" ")}`,
        scope,
      );
    const current: IntegrationMaintenance = {
      status: "current",
      plannedActions: [],
      ...(scope.unresolved === undefined
        ? {}
        : { unresolved: scope.unresolved }),
    };
    const skillDestinations = scope.skillDestinations ?? [];
    if (scope.clients.length === 0 && !scope.skill) return current;
    const command = [
      process.execPath,
      entryPoint,
      "setup",
      ...scope.clients.flatMap((client) => ["--client", client]),
      ...skillDestinations.flatMap(({ client }) => ["--skill-client", client]),
      `--skill=${String(scope.skill)}`,
    ];
    const execution = await execute([...command, "--dry-run", "--json"]);
    if (!execution.ok) return unavailableMaintenance(execution.error, scope);
    const plan = setupPlanSchema.safeParse(JSON.parse(execution.value));
    if (!plan.success)
      return unavailableMaintenance(
        `The updated setup executable returned an invalid maintenance plan: ${plan.error.message}`,
        scope,
      );
    if (plan.data.plannedActions.length === 0) return current;
    const allowedIds = new Set(
      scope.clients.map((client) => `configure_client:${client}`),
    );
    const skillTargets = new Set(skillDestinations.map(({ path }) => path));
    if (
      plan.data.plannedActions.some((action) =>
        action.kind === "install_skill"
          ? !skillTargets.has(action.target)
          : !allowedIds.has(action.id),
      )
    )
      return unavailableMaintenance(
        "The updated setup plan included an integration outside the existing REA maintenance scope.",
        scope,
      );
    return {
      status: "planned",
      scope,
      command,
      plannedActions: plan.data.plannedActions.map(
        ({ backupPath, commands, ...action }) => ({
          ...action,
          ...(backupPath === undefined ? {} : { backupPath }),
          ...(commands === undefined ? {} : { commands }),
        }),
      ),
    };
  } catch (cause: unknown) {
    // Without a supplied scope, the typed failure is the caller's cleanup capability.
    if (resources === undefined && cause instanceof RegularFileCleanupFailure)
      throw cause;
    return unavailableMaintenance(errorMessage(cause), scope);
  }
};
