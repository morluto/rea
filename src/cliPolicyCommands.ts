import { Cli, z } from "incur";

import { loadConfiguredPermissionAuthority } from "./application/PermissionConfiguration.js";
import {
  readProjectPermissionStore,
  writeProjectPermissionStore,
} from "./application/ProjectPermissionStore.js";
import { logCliCommand } from "./cliLogging.js";
import { parseConfig, type AppConfig } from "./config.js";
import {
  PermissionRequiredError,
  projectAnalysisError,
} from "./domain/errors.js";
import type { PermissionCapability } from "./domain/permissionPolicy.js";
import type { Logger } from "./logger.js";

const capabilitySchema = z.enum([
  "process_capture",
  "evidence_read",
  "evidence_write",
  "investigation_input",
  "investigation_workspace_read",
  "investigation_workspace_write",
  "snapshot_read",
  "snapshot_write",
  "artifact_extract",
  "native_mount",
  "reference_read",
]);

/** Register inspectable, dry-run, and revocation policy UX for the CLI. */
export const registerPolicyCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command("policy", {
    description: "Inspect, explain, or revoke unified local permission grants",
    args: z.object({
      action: z.enum(["status", "list", "explain", "revoke"]),
      value: z.string().optional(),
    }),
    options: z.object({
      root: z.string().optional(),
      executable: z.string().optional(),
      environmentNames: z.array(z.string()).default([]),
      network: z.enum(["none", "loopback", "external"]).default("none"),
      mount: z.boolean().default(false),
      write: z.boolean().default(false),
    }),
    alias: { environmentNames: "environment-names" },
    run: ({ args, options }) =>
      logCliCommand(logger, "policy", async () => {
        const config = parseConfig(process.env);
        if (!config.ok) return failure(config.error);
        if (args.action === "status")
          return {
            reload: "SIGHUP",
            restart_required: false,
            administrator_ceilings: config.value.permissionCeilings,
            project_store: config.value.permissionProjectStore ?? null,
          };
        if (args.action === "list")
          return readProjectGrants(config.value).then((result) =>
            result.ok ? { grants: result.grants } : result.error,
          );
        if (args.action === "revoke") {
          if (args.value === undefined)
            return { error: "Grant ID is required for policy revoke" };
          const result = await readProjectGrants(config.value);
          if (!result.ok) return result.error;
          const retained = result.grants.filter(
            ({ grant_id }) => grant_id !== args.value,
          );
          if (retained.length === result.grants.length)
            return { error: "Grant was not found", grant_id: args.value };
          const written = await writeProjectPermissionStore(
            result.path,
            result.root,
            retained,
          );
          return written.ok
            ? {
                revoked: args.value,
                reload: "Send SIGHUP to the REA MCP process",
              }
            : { error: written.error.message };
        }
        const capability = capabilitySchema.safeParse(args.value);
        if (!capability.success)
          return {
            error: "A registered capability is required for policy explain",
          };
        return explain(config.value, capability.data, options);
      }),
  });
};

const explain = async (
  config: AppConfig,
  capability: PermissionCapability,
  options: {
    readonly root?: string | undefined;
    readonly executable?: string | undefined;
    readonly environmentNames: readonly string[];
    readonly network: "none" | "loopback" | "external";
    readonly mount: boolean;
    readonly write: boolean;
  },
) => {
  const authority = await loadConfiguredPermissionAuthority(config);
  if (!authority.ok) return failure(authority.error);
  const evaluated = await authority.value.explain(
    {
      capability,
      roots: options.root === undefined ? [] : [options.root],
      executables: options.executable === undefined ? [] : [options.executable],
      environment_names: options.environmentNames,
      network: options.network,
      mount: options.mount,
      operation_identity: `policy_explain:${capability}`,
    },
    options.write ? "write" : "read",
  );
  return evaluated.ok
    ? { allowed: true, grant_id: evaluated.value.grant_id }
    : evaluated.error instanceof PermissionRequiredError
      ? { allowed: false, error: projectAnalysisError(evaluated.error) }
      : { allowed: false, error: evaluated.error.message };
};

const readProjectGrants = async (config: {
  readonly permissionProjectRoot: string | undefined;
  readonly permissionProjectStore: string | undefined;
}) => {
  if (
    config.permissionProjectRoot === undefined ||
    config.permissionProjectStore === undefined
  )
    return {
      ok: false as const,
      error: { error: "Project policy is not configured" },
    };
  const store = await readProjectPermissionStore(
    config.permissionProjectStore,
    config.permissionProjectRoot,
  );
  return store.ok
    ? {
        ok: true as const,
        grants: store.value?.grants ?? [],
        path: config.permissionProjectStore,
        root: config.permissionProjectRoot,
      }
    : { ok: false as const, error: { error: store.error.message } };
};

const failure = (error: Parameters<typeof projectAnalysisError>[0]) => ({
  error: "Policy command failed",
  ...projectAnalysisError(error),
});
