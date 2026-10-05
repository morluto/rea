import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { PRODUCT_IDENTITY } from "../identity.js";
import { isOwnedClientRegistrationCommand } from "./ClientRegistrationIdentity.js";
import { readClientRegistrationStatuses } from "./ClientRegistrationStatus.js";
import { parseClientConfiguration } from "./ClientConfigurationDocument.js";
import { supportedClients } from "./SupportedClients.js";
import type { SetupAction } from "./Setup.js";
import type { Result } from "../domain/result.js";

/** Existing REA integrations selected for maintenance, without discovering new targets. */
export interface MaintenanceScope {
  readonly clients: readonly string[];
  readonly skill: boolean;
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

/** Discover owned registrations and an existing REA skill without writes. */
export const existingMaintenanceScope = async (
  home: string,
  entryPoint: string,
): Promise<MaintenanceScope> => {
  const registrations = await readClientRegistrationStatuses(home, entryPoint);
  const supported = supportedClients(home);
  const clients: string[] = [];
  for (const registration of registrations) {
    if (
      (registration.state !== "aligned" && registration.state !== "stale") ||
      !isOwnedClientRegistrationCommand(registration.command, entryPoint)
    )
      continue;
    const client = supported.find(({ name }) => name === registration.client);
    if (client === undefined) continue;
    const { servers } = parseClientConfiguration(
      await readFile(client.configPath, "utf8"),
      client.format,
    );
    const enabled = z
      .object({
        enabled: z.boolean().optional(),
        disabled: z.boolean().optional(),
      })
      .parse(servers[PRODUCT_IDENTITY.mcpServerKey]);
    if (enabled.enabled !== false && enabled.disabled !== true)
      clients.push(client.name);
  }
  let skill = false;
  try {
    const content = await readFile(
      join(home, ".agents", "skills", PRODUCT_IDENTITY.skillName, "SKILL.md"),
      "utf8",
    );
    skill =
      content.startsWith(`---\nname: ${PRODUCT_IDENTITY.skillName}\n`) ||
      content.startsWith(`---\r\nname: ${PRODUCT_IDENTITY.skillName}\r\n`);
  } catch (cause: unknown) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
      throw cause;
  }
  return { clients, skill };
};

/** Ask the verified new executable to plan only existing REA integrations. */
export const planIntegrationMaintenance = async (
  home: string,
  entryPoint: string,
  execute: (command: readonly string[]) => Promise<Result<string, string>>,
): Promise<IntegrationMaintenance> => {
  try {
    const scope = await existingMaintenanceScope(home, entryPoint);
    if (scope.clients.length === 0 && !scope.skill)
      return { status: "current", plannedActions: [] };
    const command = [
      process.execPath,
      entryPoint,
      "setup",
      ...scope.clients.flatMap((client) => ["--client", client]),
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
    const allowedIds = new Set([
      ...scope.clients.map((client) => `configure_client:${client}`),
      ...(scope.skill ? ["install_skill"] : []),
    ]);
    if (plan.data.plannedActions.some(({ id }) => !allowedIds.has(id)))
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
