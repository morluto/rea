import { z } from "zod";
import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";

import {
  readClientRegistrationInspections,
  type ClientRegistrationStatus,
} from "./ClientRegistrationStatus.js";
import {
  existingSkillDestinations,
  type SkillPathIssue,
} from "./SetupSkill.js";
import type { SetupAction } from "./SetupTypes.js";
import type { Result } from "../domain/result.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";

/** Existing REA integrations selected for maintenance, without discovering new targets. */
export interface MaintenanceScope {
  readonly clients: readonly string[];
  readonly skill: boolean;
  readonly unresolved?: readonly ClientRegistrationStatus[];
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
      readonly unresolved?: readonly ClientRegistrationStatus[];
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
}: ClientRegistrationStatus): string =>
  `${client} (${config_path}): ${remediation ?? "Registration identity is unresolved"}`;

/** Clients a maintenance result left alone because REA cannot identify or update their registration. */
export const unresolvedMaintenanceClients = (
  maintenance: IntegrationMaintenance,
): readonly ClientRegistrationStatus[] =>
  (maintenance.status === "current"
    ? maintenance.unresolved
    : maintenance.scope?.unresolved) ?? [];

/** One sentence naming each unknown client and its own recovery. */
export const unresolvedMaintenanceRemediation = (
  unresolved: readonly ClientRegistrationStatus[],
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

/** Discover owned registrations and REA skills without writes. */
export const existingMaintenanceScope = async (
  home: string,
  entryPoint: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  resources?: ArtifactResourceScope,
): Promise<MaintenanceScope> => {
  const registrations = await readClientRegistrationInspections(
    home,
    entryPoint,
    {
      environment,
      // A registration REA wrote must be refreshed even when the product
      // profile is absent, so maintenance reads ownership evidence instead of
      // product applicability. Owned rows stay the only ones selected below.
      evidence: "ownership",
      ...(resources === undefined ? {} : { resources }),
    },
  );
  const clients: string[] = [];
  const unresolved: ClientRegistrationStatus[] = [];
  for (const {
    status: registration,
    activation,
    setupBlocker,
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
    // Setup refuses a client its own policy blocks, and one refused client
    // would fail the whole maintenance plan, so report it instead.
    if (setupBlocker !== undefined) {
      unresolved.push(registration);
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
    process.platform,
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
  resources?: ArtifactResourceScope,
): Promise<IntegrationMaintenance> => {
  let scope: MaintenanceScope | undefined;
  try {
    scope = await existingMaintenanceScope(
      home,
      entryPoint,
      environment,
      resources,
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
    return unavailableMaintenance(
      cause instanceof Error ? cause.message : String(cause),
      scope,
    );
  }
};
