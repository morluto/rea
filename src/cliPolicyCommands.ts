import { Cli, z } from "incur";
import { createInterface } from "node:readline/promises";

import { loadConfiguredPermissionAuthority } from "./application/PermissionConfiguration.js";
import {
  readProjectPermissionStore,
  revokeProjectPermissionGrant,
} from "./application/ProjectPermissionStore.js";
import { logCliCommand } from "./cliLogging.js";
import { parseConfig, type AppConfig } from "./config.js";
import {
  PermissionRequiredError,
  projectAnalysisError,
} from "./domain/errors.js";
import type { PermissionCapability } from "./domain/permissionPolicy.js";
import type { Logger } from "./logger.js";
import { CLI_COMMANDS } from "./cliCommandNames.js";

const capabilitySchema = z.enum([
  "process_capture",
  "browser_observe",
  "electron_observe",
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

type PolicyRevocationApproval =
  | { readonly approved: true }
  | { readonly approved: false; readonly reason: "cancelled" | "required" };

/** Require an explicit decision before a project permission grant is removed. */
export const approvePolicyRevocation = async (options: {
  readonly approved: boolean;
  readonly interactive: boolean;
  readonly grantId: string;
  readonly confirm: (grantId: string) => Promise<boolean>;
}): Promise<PolicyRevocationApproval> => {
  if (options.approved) return { approved: true };
  if (!options.interactive) return { approved: false, reason: "required" };
  return (await options.confirm(options.grantId))
    ? { approved: true }
    : { approved: false, reason: "cancelled" };
};

/** Register inspectable, dry-run, and revocation policy UX for the CLI. */
export const registerPolicyCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.policy, {
    description: "Inspect, explain, or revoke unified local permission grants",
    args: z.object({
      action: z
        .enum(["status", "list", "explain", "revoke"])
        .describe("Permission-policy operation to perform"),
      value: z
        .string()
        .optional()
        .describe("Capability to explain or grant ID to revoke"),
    }),
    options: z.object({
      root: z.string().optional().describe("Filesystem root to authorize"),
      executable: z
        .string()
        .optional()
        .describe("Executable path to authorize"),
      environmentNames: z
        .array(z.string())
        .default([])
        .describe("Environment variable names the operation may read"),
      origins: z
        .array(z.string())
        .default([])
        .describe("Exact browser origins the operation may access"),
      network: z
        .enum(["none", "loopback", "external"])
        .default("none")
        .describe("Maximum network scope to authorize"),
      mount: z
        .boolean()
        .default(false)
        .describe("Authorize mounting an artifact filesystem"),
      write: z
        .boolean()
        .default(false)
        .describe("Explain the write form of the requested capability"),
      yes: z
        .boolean()
        .default(false)
        .describe("Confirm project permission revocation without prompting"),
    }),
    alias: { environmentNames: "environment-names", yes: "y" },
    run: ({ agent, args, formatExplicit, options }) =>
      logCliCommand(logger, "policy", async () => {
        const config = parseConfig(process.env);
        if (!config.ok) return failure(config.error);
        if (args.action === "status") return policyStatus(config.value);
        if (args.action === "list") return policyList(config.value);
        if (args.action === "revoke")
          return policyRevoke({
            config: config.value,
            grantId: args.value,
            approved: options.yes,
            interactive:
              !agent && !formatExplicit && process.stdin.isTTY === true,
            confirm: confirmPolicyRevocation,
          });
        const capability = capabilitySchema.safeParse(args.value);
        if (!capability.success)
          return {
            error: "A registered capability is required for policy explain",
          };
        return policyExplain(config.value, capability.data, options);
      }),
  });
};

const policyStatus = (config: AppConfig) => ({
  reload: "SIGHUP",
  restart_required: false,
  administrator_ceilings: config.permissionCeilings,
  project_store: config.permissionProjectStore ?? null,
});

const policyList = (config: AppConfig) =>
  readProjectGrants(config).then((result) =>
    result.ok ? { grants: result.grants } : result.error,
  );

interface PolicyRevokeContext {
  readonly config: AppConfig;
  readonly grantId: string | undefined;
  readonly approved: boolean;
  readonly interactive: boolean;
  readonly confirm: (grantId: string) => Promise<boolean>;
}

const policyRevoke = async (context: PolicyRevokeContext) => {
  if (context.grantId === undefined)
    return { error: "Grant ID is required for policy revoke" };
  const { permissionProjectRoot, permissionProjectStore } = context.config;
  if (
    permissionProjectRoot === undefined ||
    permissionProjectStore === undefined
  )
    return { error: "Project policy is not configured" };
  const approval = await approvePolicyRevocation({
    approved: context.approved,
    interactive: context.interactive,
    grantId: context.grantId,
    confirm: context.confirm,
  });
  if (!approval.approved)
    return approval.reason === "required"
      ? {
          error:
            "Policy revoke requires confirmation. Rerun interactively or with --yes.",
          grant_id: context.grantId,
        }
      : {
          error: "Policy revocation was cancelled",
          grant_id: context.grantId,
        };
  const revoked = await revokeProjectPermissionGrant(
    permissionProjectStore,
    permissionProjectRoot,
    context.grantId,
  );
  return revoked.ok && revoked.value
    ? {
        revoked: context.grantId,
        reload: "Send SIGHUP to the REA MCP process",
      }
    : revoked.ok
      ? { error: "Grant was not found", grant_id: context.grantId }
      : { error: revoked.error.message };
};

const policyExplain = async (
  config: AppConfig,
  capability: PermissionCapability,
  options: {
    readonly root?: string | undefined;
    readonly executable?: string | undefined;
    readonly environmentNames: readonly string[];
    readonly origins: readonly string[];
    readonly network: "none" | "loopback" | "external";
    readonly mount: boolean;
    readonly write: boolean;
  },
) => explain(config, capability, options);

const confirmPolicyRevocation = async (grantId: string): Promise<boolean> => {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question(
      `Revoke project permission grant ${JSON.stringify(grantId)}? [y/N] `,
    );
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    prompt.close();
  }
};

const explain = async (
  config: AppConfig,
  capability: PermissionCapability,
  options: {
    readonly root?: string | undefined;
    readonly executable?: string | undefined;
    readonly environmentNames: readonly string[];
    readonly origins: readonly string[];
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
      origins: options.origins,
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
