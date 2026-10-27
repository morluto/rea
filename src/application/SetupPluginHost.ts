import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ok } from "../domain/result.js";
import { SetupCleanupOwner } from "./SetupCleanupOwner.js";
import type { DoctorCheck } from "./Doctor.js";
import type { SetupHost, SetupAction } from "./SetupTypes.js";
import type { RegistrationRunnerLauncher } from "./SetupRegistrationPrewarm.js";
import {
  SetupPluginClient,
  REA_PLUGIN_ID,
  type PluginInspection,
} from "./SetupPluginClient.js";

type ClientRoute =
  | { readonly mode: "direct" }
  | { readonly mode: "blocked"; readonly remediation: string }
  | {
      readonly mode: "plugin";
      readonly manager: SetupPluginClient;
      readonly installed: boolean;
      readonly enabled: boolean;
    };

/** Keep approval, ownership and recovery in setup; delegate plugin state to its client. */
class PluginSetupHost {
  private readonly resources = new ArtifactResourceScope();
  private readonly cleanup = new SetupCleanupOwner([
    { close: async () => this.host.close?.() },
    { close: () => this.resources.close() },
  ]);
  private providerSettings = false;
  private configuredDirectClient = false;
  private readonly approvedPluginClients = new Set<string>();
  private readonly pending = new Map<string, Promise<ClientRoute>>();
  private readonly routes = new Map<string, ClientRoute>();
  constructor(
    private readonly host: SetupHost,
    private readonly environment: Readonly<NodeJS.ProcessEnv>,
    private readonly preferPlugins: boolean,
    private readonly launch?: RegistrationRunnerLauncher,
  ) {}
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
  private inspectRoute = async (id: string): Promise<ClientRoute> => {
    // Explicit direct setup must not launch a client that can migrate its settings.
    if (!this.preferPlugins || this.providerSettings) return { mode: "direct" };
    const command =
      id === "codex" ? "codex" : id === "claude_code" ? "claude" : undefined;
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
    const manager = new SetupPluginClient(
      command,
      this.environment,
      this.resources,
      this.launch,
    );
    // Claude's inventory command can migrate settings, so defer it until approval.
    if (command === "claude")
      return { mode: "plugin", manager, installed: false, enabled: false };
    const state = await manager.inspect();
    if (state.status === "unsupported") return { mode: "direct" };
    if (state.status === "invalid")
      return { mode: "blocked", remediation: state.remediation };
    return {
      mode: "plugin",
      manager,
      installed: state.installed,
      enabled: state.enabled,
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
    const providerSettings = installHopper || Object.keys(settings).length > 0;
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

  private configureClient: NonNullable<SetupHost["configureClient"]> = async (
    client,
    settings,
    command,
  ) => {
    const selected = await this.route(client.name);
    if (selected.mode === "direct") {
      const result = await this.host.configureClient(client, settings, command);
      this.configuredDirectClient ||= result.status === "configured";
      return result;
    }
    if (selected.mode === "blocked")
      return {
        status: "failed",
        reason: "plugin",
        detail: selected.remediation,
      };
    const current = await this.host.inspectClientConfiguration(
      client,
      settings,
      command,
    );
    if (
      current.status === "invalid" ||
      current.status === "already_current" ||
      !(await this.directRegistrationMissing(client.name))
    )
      return {
        status: "failed",
        reason: "plugin",
        detail:
          "Client configuration changed after the plugin plan was approved. Rerun setup to avoid adding a duplicate server.",
      };
    this.approvedPluginClients.add(client.name);
    const state = await selected.manager.inspect();
    const failure =
      state.status === "invalid"
        ? state.remediation
        : state.status === "unsupported"
          ? "The client does not support plugin commands. Update the client, or explicitly choose direct setup with --skill=false."
          : state.installed && state.enabled
            ? undefined
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
    return ids.length > 0 && direct.length === 0
      ? ok("unchanged")
      : this.host.installSkill(direct);
  };

  private prewarmRegistrationRunner: NonNullable<
    SetupHost["prewarmRegistrationRunner"]
  > = async () =>
    this.configuredDirectClient &&
    this.host.prewarmRegistrationRunner !== undefined
      ? this.host.prewarmRegistrationRunner()
      : { status: "skipped", reason: "direct_launcher" };

  private inspectPluginReadiness = async (
    id: string,
  ): Promise<PluginInspection | undefined> => {
    const selected = this.routes.get(id);
    if (
      selected?.mode !== "plugin" ||
      (id === "claude_code" && !this.approvedPluginClients.has(id))
    )
      return undefined;
    return selected.manager.inspect();
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
            : `${REA_PLUGIN_ID} must be installed and enabled in the client.`,
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
      prewarmRegistrationRunner: this.prewarmRegistrationRunner,
      doctor: this.doctor,
    };
  }
}

export const withPluginSetup = (
  host: SetupHost,
  environment: Readonly<NodeJS.ProcessEnv>,
  preferPlugins: boolean,
  launch?: RegistrationRunnerLauncher,
): SetupHost =>
  new PluginSetupHost(host, environment, preferPlugins, launch).asHost();
