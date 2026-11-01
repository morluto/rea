import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { CursorLocalPlugin } from "./CursorLocalPlugin.js";
import { ok } from "../domain/result.js";
import { explicitSetupRegistrationEnvironment } from "./SetupRegistrationEnvironment.js";
import { SetupCleanupOwner } from "./SetupCleanupOwner.js";
import { throwIfSetupCancelled } from "./SetupCancellation.js";
import { launchPluginCommand } from "./SetupPluginCommands.js";
import type { DoctorCheck } from "./Doctor.js";
import type { SetupHost, SetupAction } from "./SetupTypes.js";
import type { SetupPluginCommandLauncher } from "./SetupPluginCommand.js";
import {
  SetupPluginClient,
  REA_PLUGIN_ID,
  type PluginInspection,
} from "./SetupPluginClient.js";

interface PluginSetupOptions {
  readonly signal?: AbortSignal;
  readonly preferPlugins: boolean;
  readonly cursorPlugin?: boolean;
}

type ClientRoute =
  | {
      readonly mode: "direct";
      /** Only automatic fallback retains the read-only plugin absence probe. */
      readonly recheckPlugin?: () => Promise<PluginInspection>;
    }
  | { readonly mode: "blocked"; readonly remediation: string }
  | {
      readonly mode: "plugin";
      readonly manager: SetupPluginClient | CursorLocalPlugin;
      readonly installed: boolean;
      readonly enabled: boolean;
    };

/** Keep approval, ownership and recovery in setup; delegate plugin state to its client. */
class PluginSetupHost {
  private readonly launch: SetupPluginCommandLauncher;
  private readonly resources = new ArtifactResourceScope();
  private readonly cleanup = new SetupCleanupOwner([
    { close: async () => this.host.close?.() },
    { close: () => this.resources.close() },
  ]);
  private providerSettings = false;
  private readonly approvedPluginClients = new Set<string>();
  private readonly pending = new Map<string, Promise<ClientRoute>>();
  private readonly routes = new Map<string, ClientRoute>();
  constructor(
    private readonly host: SetupHost,
    private readonly environment: Readonly<NodeJS.ProcessEnv>,
    private readonly options: PluginSetupOptions,
    launch?: SetupPluginCommandLauncher,
  ) {
    this.launch = async (command, args, invocation) => {
      throwIfSetupCancelled(this.options.signal);
      const result = await (launch ?? launchPluginCommand)(command, args, {
        ...invocation,
        ...(this.options.signal === undefined
          ? {}
          : { signal: this.options.signal }),
      });
      throwIfSetupCancelled(this.options.signal);
      return result;
    };
  }
  private directRegistrationMissing = async (id: string): Promise<boolean> => {
    const report = await this.host.doctor({
      clients: [id],
      providers: [],
      skill: false,
    });
    return (
      report.identity?.registrations.some(
        (registration) =>
          registration.client === id && registration.state === "missing",
      ) === true
    );
  };
  private pluginRequested(
    id: string,
    state: PluginInspection | undefined,
  ): boolean {
    return (
      id !== "cursor" ||
      this.options.cursorPlugin === true ||
      (state?.status === "available" && state.installed)
    );
  }
  private inspectRoute = async (id: string): Promise<ClientRoute> => {
    // Explicit direct setup must not launch a client that can migrate its settings.
    if (!this.options.preferPlugins || this.providerSettings)
      return { mode: "direct" };
    const commands: Readonly<Record<string, "codex" | "claude" | "cursor">> = {
      codex: "codex",
      claude_code: "claude",
      cursor: "cursor",
    };
    const command = commands[id];
    if (command === undefined) return { mode: "direct" };
    const client = (await this.host.supportedClients()).find(
      ({ name }) => name === id,
    );
    if (client === undefined) return { mode: "direct" };
    const direct = await this.host.inspectClientConfiguration(
      client,
      {},
      this.host.registrationCommand,
    );
    // A plugin manager can create settings without adding a direct REA server.
    if (
      direct.status === "invalid" ||
      direct.status === "already_current" ||
      !(await this.directRegistrationMissing(id))
    )
      return { mode: "direct" };
    const manager =
      command === "cursor"
        ? new CursorLocalPlugin(
            this.host.homeDirectory,
            this.environment,
            this.resources,
            this.launch,
          )
        : new SetupPluginClient(
            command,
            this.environment,
            this.resources,
            this.launch,
          );
    // Claude inventory can migrate settings; the other inventory paths are read-only.
    const state = command !== "claude" ? await manager.inspect() : undefined;
    if (state?.status === "unsupported") return { mode: "direct" };
    if (state?.status === "invalid")
      return { mode: "blocked", remediation: state.remediation };
    if (!this.pluginRequested(id, state))
      return { mode: "direct", recheckPlugin: () => manager.inspect() };
    const runtimeFailure = await manager.inspectRuntime();
    if (runtimeFailure !== undefined)
      return { mode: "blocked", remediation: runtimeFailure };
    return {
      mode: "plugin",
      manager,
      installed: state?.installed ?? false,
      enabled: state?.enabled ?? false,
    };
  };
  private route = (id: string): Promise<ClientRoute> => {
    let value = this.pending.get(id);
    if (value === undefined) {
      value = this.inspectRoute(id).then((result) => {
        this.routes.set(id, result);
        return result;
      });
      this.pending.set(id, value);
    }
    return value;
  };
  private directSkillClients = async (ids: readonly string[]) => {
    const selected: string[] = [];
    for (const id of ids)
      if ((await this.route(id)).mode !== "plugin") selected.push(id);
    return selected;
  };
  private pluginAction = (id: string): SetupAction | undefined => {
    const selected = this.routes.get(id);
    if (selected?.mode !== "plugin") return undefined;
    if (selected.manager instanceof CursorLocalPlugin)
      return {
        id: `configure_client:${id}`,
        kind: "configure_client",
        label: "REA local plugin for Cursor",
        target: selected.manager.directory,
        detail:
          "Download the exact REA npm release into a private staging directory, verify its bundled runtime and skill, then publish a local Cursor plugin. Existing local plugins are preserved; no direct MCP registration or separate skill copy is created. Restart Cursor or reload its window. Local imports must be permitted by Enterprise policy; an existing marketplace plugin takes precedence. This is a local installation and does not sync through a Cursor account.",
        external: true,
        operation: "install",
        commands: selected.manager
          .commands(false)
          .map((args) => [selected.manager.command, ...args].join(" ")),
        networkOrigins: ["https://registry.npmjs.org"],
      };
    return {
      id: `configure_client:${id}`,
      kind: "configure_client",
      label: `REA plugin for ${id === "codex" ? "Codex" : "Claude Code"}`,
      target: this.host.homeDirectory,
      detail: `Check, install or enable ${REA_PLUGIN_ID} using the client's plugin manager. The plugin bundles its MCP server and skill; no separate registration or skill copy is created. ${id === "codex" ? "Use the same Codex home in the CLI and desktop app, then start a new chat." : "Inventory is deferred until approval because Claude Code can migrate settings when listing plugins. Already enabled plugins are left installed. Reload plugins or restart Claude Code. Local CLI installs do not sync to Claude chat or Cowork."}`,
      external: true,
      operation: "install",
      commands: (id === "claude_code"
        ? [
            ["plugin", "list", "--json"],
            ...selected.manager.commands(false),
            ...selected.manager.commands(true),
          ]
        : selected.manager.commands(selected.installed)
      ).map((args) => [selected.manager.command, ...args].join(" ")),
      networkOrigins: [
        "https://github.com/morluto/rea",
        "https://registry.npmjs.org",
      ],
    };
  };
  private close: NonNullable<SetupHost["close"]> = () => this.cleanup.close();

  private prepareClientSetup: NonNullable<SetupHost["prepareClientSetup"]> = (
    installHopper,
    settings,
  ) => {
    const providerSettings =
      installHopper ||
      Object.keys(explicitSetupRegistrationEnvironment(this.environment))
        .length > 0;
    if (providerSettings !== this.providerSettings) {
      this.pending.clear();
      this.routes.clear();
    }
    this.providerSettings = providerSettings;
    this.host.prepareClientSetup?.(installHopper, settings);
  };

  private inspectClientConfiguration: NonNullable<
    SetupHost["inspectClientConfiguration"]
  > = async (client, settings, command) => {
    const selected = await this.route(client.name);
    return selected.mode === "blocked"
      ? { status: "invalid", remediation: selected.remediation }
      : selected.mode === "plugin"
        ? {
            status:
              selected.installed && selected.enabled
                ? "already_current"
                : "create",
          }
        : this.host.inspectClientConfiguration(client, settings, command);
  };

  private clientNeedsConfigure: NonNullable<SetupHost["clientNeedsConfigure"]> =
    async (client, settings, command) => {
      const selected = await this.route(client.name);
      return selected.mode === "plugin"
        ? !selected.installed || !selected.enabled
        : selected.mode === "blocked" ||
            (await this.host.clientNeedsConfigure(client, settings, command));
    };

  private async directPluginChange(
    route: Extract<ClientRoute, { readonly mode: "direct" }>,
  ): Promise<string | undefined> {
    const state = await route.recheckPlugin?.();
    if (
      state === undefined ||
      (state.status === "available" && !state.installed)
    )
      return undefined;
    return state.status === "available"
      ? "A local Cursor plugin appeared after the direct setup plan was approved. Rerun setup to review the plugin route; no direct registration was added."
      : state.remediation;
  }

  private configureClient: NonNullable<SetupHost["configureClient"]> = async (
    client,
    settings,
    command,
  ) => {
    const selected = await this.route(client.name);
    throwIfSetupCancelled(this.options.signal);
    if (selected.mode === "direct") {
      const change = await this.directPluginChange(selected);
      throwIfSetupCancelled(this.options.signal);
      return change === undefined
        ? this.host.configureClient(client, settings, command)
        : { status: "failed", reason: "plugin", detail: change };
    }
    if (selected.mode === "blocked")
      return {
        status: "failed",
        reason: "plugin",
        detail: selected.remediation,
      };
    const checkDirectRegistration = async (): Promise<string | undefined> => {
      throwIfSetupCancelled(this.options.signal);
      const current = await this.host.inspectClientConfiguration(
        client,
        settings,
        command,
      );
      const changed =
        current.status === "invalid" ||
        current.status === "already_current" ||
        !(await this.directRegistrationMissing(client.name));
      throwIfSetupCancelled(this.options.signal);
      return changed
        ? "Client configuration changed after the plugin plan was approved. Rerun setup to avoid adding a duplicate server."
        : undefined;
    };
    const registrationChange = await checkDirectRegistration();
    if (registrationChange !== undefined)
      return {
        status: "failed",
        reason: "plugin",
        detail: registrationChange,
      };
    const runtimeFailure = await selected.manager.inspectRuntime();
    if (runtimeFailure !== undefined)
      return { status: "failed", reason: "plugin", detail: runtimeFailure };
    this.approvedPluginClients.add(client.name);
    const state = await selected.manager.inspect();
    const failure =
      state.status === "invalid"
        ? state.remediation
        : state.status === "unsupported"
          ? `${state.remediation} Update the client, or explicitly choose direct setup with --skill=false.`
          : state.installed && state.enabled
            ? undefined
            : selected.manager instanceof CursorLocalPlugin
              ? await selected.manager.install(
                  state.installed,
                  checkDirectRegistration,
                  this.options.signal,
                )
              : await selected.manager.install(state.installed);
    return failure === undefined
      ? { status: "configured" }
      : { status: "failed", reason: "plugin", detail: failure };
  };

  private skillDestinations: NonNullable<SetupHost["skillDestinations"]> = (
    ids,
  ) => {
    const direct = ids.filter((id) => this.routes.get(id)?.mode !== "plugin");
    return ids.length > 0 && direct.length === 0
      ? []
      : this.host.skillDestinations(direct);
  };

  private skillNeedsInstall: NonNullable<SetupHost["skillNeedsInstall"]> =
    async (ids) => {
      const direct = await this.directSkillClients(ids);
      return ids.length > 0 && direct.length === 0
        ? false
        : this.host.skillNeedsInstall(direct);
    };

  private validateSkillDirectories: NonNullable<
    SetupHost["validateSkillDirectories"]
  > = async (ids) => {
    const direct = await this.directSkillClients(ids);
    return ids.length > 0 && direct.length === 0
      ? ok(undefined)
      : this.host.validateSkillDirectories(direct);
  };

  private installSkill: NonNullable<SetupHost["installSkill"]> = async (
    ids,
  ) => {
    const direct = await this.directSkillClients(ids);
    throwIfSetupCancelled(this.options.signal);
    return ids.length > 0 && direct.length === 0
      ? ok("unchanged")
      : this.host.installSkill(direct);
  };

  private inspectPluginReadiness = async (
    id: string,
  ): Promise<PluginInspection | undefined> => {
    const selected = this.routes.get(id);
    if (
      selected?.mode !== "plugin" ||
      (id === "claude_code" && !this.approvedPluginClients.has(id))
    )
      return undefined;
    const runtimeFailure = await selected.manager.inspectRuntime();
    return runtimeFailure === undefined
      ? selected.manager.inspect()
      : { status: "invalid", remediation: runtimeFailure };
  };

  private doctor: NonNullable<SetupHost["doctor"]> = async (scope) => {
    const pluginIds = (scope?.clients ?? []).filter(
      (id) => this.routes.get(id)?.mode === "plugin",
    );
    const skillIds = (scope?.skillClients ?? []).filter(
      (id) => this.routes.get(id)?.mode !== "plugin",
    );
    const report = await this.host.doctor(
      pluginIds.length === 0
        ? scope
        : {
            ...scope,
            clients: (scope?.clients ?? []).filter(
              (id) => !pluginIds.includes(id),
            ),
            skill:
              scope?.skill === true &&
              (scope.skillClients === undefined || skillIds.length > 0),
            skillClients: skillIds,
          },
    );
    const checks: DoctorCheck[] = [];
    for (const id of pluginIds) {
      const state = await this.inspectPluginReadiness(id);
      const healthy =
        state?.status === "available" && state.installed && state.enabled;
      checks.push({
        name: `plugin:${id}`,
        ok: healthy,
        classification: healthy ? "healthy" : "config_drift",
        detail:
          state === undefined
            ? "Plugin inventory was not inspected because this client was not approved."
            : state.status !== "available"
              ? state.remediation
              : "REA plugin must be installed and enabled. Restart the client to load it; local package verification does not establish live client policy or tool availability.",
      });
    }
    return {
      ...report,
      healthy: report.healthy && checks.every(({ ok }) => ok),
      scope: {
        ...report.scope,
        ...(pluginIds.length === 0 ? {} : { plugin_clients: pluginIds }),
      },
      checks: [...report.checks, ...checks],
      scope_checks: [...report.scope_checks, ...checks],
    };
  };
  asHost(): SetupHost {
    return {
      ...this.host,
      clientSetupAction: this.pluginAction,
      close: this.close,
      prepareClientSetup: this.prepareClientSetup,
      inspectClientConfiguration: this.inspectClientConfiguration,
      clientNeedsConfigure: this.clientNeedsConfigure,
      configureClient: this.configureClient,
      skillDestinations: this.skillDestinations,
      skillNeedsInstall: this.skillNeedsInstall,
      validateSkillDirectories: this.validateSkillDirectories,
      installSkill: this.installSkill,
      doctor: this.doctor,
    };
  }
}

export const withPluginSetup = (
  host: SetupHost,
  environment: Readonly<NodeJS.ProcessEnv>,
  options: PluginSetupOptions,
  launch?: SetupPluginCommandLauncher,
): SetupHost =>
  new PluginSetupHost(host, environment, options, launch).asHost();
