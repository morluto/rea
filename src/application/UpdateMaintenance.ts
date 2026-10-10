import { readFile } from "node:fs/promises";
import { z } from "zod";

import { PRODUCT_IDENTITY } from "../identity.js";
import { isOwnedClientRegistrationCommand } from "./ClientRegistrationIdentity.js";
import { readClientRegistrationStatuses } from "./ClientRegistrationStatus.js";
import {
  clientServerForcedEnabled,
  clientServerListedDisabled,
  effectiveClientServer,
  parseClientConfiguration,
} from "./ClientConfigurationDocument.js";
import { supportedClients } from "./SupportedClients.js";
import { existingSkillDestinations } from "./SetupSkill.js";
import type { SetupAction } from "./SetupTypes.js";
import type { Result } from "../domain/result.js";

/** Existing REA integrations selected for maintenance, without discovering new targets. */
export interface MaintenanceScope {
  readonly clients: readonly string[];
  readonly skill: boolean;
  readonly skillDestinations?: readonly {
    readonly client: string;
    readonly path: string;
  }[];
}

/** Unapplied maintenance evidence produced by the updated setup executable. */
export type IntegrationMaintenance =
  | { readonly status: "current"; readonly plannedActions: readonly [] }
  | {
      readonly status: "planned";
      readonly scope: MaintenanceScope;
      readonly command: readonly string[];
      readonly plannedActions: readonly SetupAction[];
    }
  | { readonly status: "unavailable"; readonly remediation: string };

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

/** Discover owned registrations and REA skills without writes. */
export const existingMaintenanceScope = async (
  home: string,
  entryPoint: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<MaintenanceScope> => {
  const registrations = await readClientRegistrationStatuses(home, entryPoint, {
    environment,
  });
  const supported = supportedClients(home, process.platform, environment);
  const clients: string[] = [];
  for (const registration of registrations) {
    if (
      (registration.state !== "aligned" && registration.state !== "stale") ||
      !isOwnedClientRegistrationCommand(registration.command, entryPoint)
    )
      continue;
    const client = supported.find(({ name }) => name === registration.client);
    if (client === undefined) continue;
    const parsed = parseClientConfiguration(
      await readFile(client.configPath, "utf8"),
      client.format,
    );
    const enabled = z
      .object({
        enabled: z.boolean().optional(),
        disabled: z.boolean().optional(),
      })
      .parse(effectiveClientServer(parsed, PRODUCT_IDENTITY.mcpServerKey));
    // Root disable lists override enabled entries and OMP's force-on allowlist.
    if (
      (enabled.enabled !== false ||
        clientServerForcedEnabled(parsed, PRODUCT_IDENTITY.mcpServerKey)) &&
      enabled.disabled !== true &&
      !clientServerListedDisabled(parsed, PRODUCT_IDENTITY.mcpServerKey)
    )
      clients.push(client.name);
  }
  const skillDestinations = await existingSkillDestinations(home, environment);
  return {
    clients,
    skill: skillDestinations.length > 0,
    skillDestinations,
  };
};

/** Ask the verified new executable to plan only existing REA integrations. */
export const planIntegrationMaintenance = async (
  home: string,
  entryPoint: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  execute: (command: readonly string[]) => Promise<Result<string, string>>,
): Promise<IntegrationMaintenance> => {
  try {
    const scope = await existingMaintenanceScope(home, entryPoint, environment);
    const skillDestinations = scope.skillDestinations ?? [];
    if (scope.clients.length === 0 && !scope.skill)
      return { status: "current", plannedActions: [] };
    const command = [
      process.execPath,
      entryPoint,
      "setup",
      ...scope.clients.flatMap((client) => ["--client", client]),
      ...skillDestinations.flatMap(({ client }) => ["--skill-client", client]),
      `--skill=${String(scope.skill)}`,
    ];
    const execution = await execute([...command, "--dry-run", "--json"]);
    if (!execution.ok)
      return { status: "unavailable", remediation: execution.error };
    const plan = setupPlanSchema.safeParse(JSON.parse(execution.value));
    if (!plan.success)
      return {
        status: "unavailable",
        remediation: `The updated setup executable returned an invalid maintenance plan: ${plan.error.message}`,
      };
    if (plan.data.plannedActions.length === 0)
      return { status: "current", plannedActions: [] };
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
      return {
        status: "unavailable",
        remediation:
          "The updated setup plan included an integration outside the existing REA maintenance scope.",
      };
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
    return {
      status: "unavailable",
      remediation: cause instanceof Error ? cause.message : String(cause),
    };
  }
};
