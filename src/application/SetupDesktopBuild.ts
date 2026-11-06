import { DESKTOP_EXPORT_FRAMEWORK_VERSION } from "../domain/desktop/appExport.js";
import { AGENTENV_INSTALL_COMMAND } from "./DesktopBuildDoctor.js";
import { DESKTOP_BUILD_PROVIDER_ID } from "./DoctorProviderIds.js";
import type {
  SetupAction,
  SetupOptions,
  SetupProgressEvent,
  SetupProviderEnvironment,
} from "./SetupTypes.js";

/** What setup reads from a host before it plans a desktop build setup. */
export interface DesktopBuildSetupFacts {
  /** Each build setting resolved to an absolute path; absent when none resolves. */
  readonly settings: SetupProviderEnvironment;
  /** Settings the caller's environment selected, which setup records as they are. */
  readonly selected: readonly string[];
  readonly archive: string;
  readonly archivePacked: boolean;
  /** Why this REA cannot pack its runtime, when it cannot. */
  readonly packBlocker?: string;
  readonly agentEnvVersion?: string | undefined;
  /** uv on PATH and the agent-env its tool install places. */
  readonly uv?: { readonly path: string; readonly agentEnv: string };
  /** Per client, the build settings its registration already records with a value of its own. */
  readonly recorded: Readonly<Record<string, readonly string[]>>;
}

/** Effects `rea setup --desktop-build` needs from its host. */
export interface DesktopBuildSetupHost {
  facts(clientIds: readonly string[]): Promise<DesktopBuildSetupFacts>;
  /** Pack this REA as the build-computer runtime; the reason when it failed. */
  packRuntime(archive: string): Promise<string | undefined>;
  /** Install the pinned agentenv-framework with uv; the reason when it failed. */
  installAgentenv(uv: string): Promise<string | undefined>;
}

/** A desktop build setup as runSetup drives it; inert when it was not selected. */
export interface DesktopBuildSetup {
  readonly selected: boolean;
  readonly blocker?: string;
  readonly actions: readonly SetupAction[];
  /** Settings added to each selected client's registration only. */
  readonly clientEnvironments: Readonly<
    Record<string, SetupProviderEnvironment>
  >;
  readonly remediation?: string;
  /** Run the approved install and pack; the remediation for whatever failed. */
  apply(
    appliedActions: string[],
    onProgress?: (event: SetupProgressEvent) => void,
  ): Promise<string | undefined>;
  /** Where to look when the build host is not ready after setup. */
  readinessRemediation(healthy: boolean): string | undefined;
}

const inert = (blocker?: string): DesktopBuildSetup => ({
  selected: blocker !== undefined,
  ...(blocker === undefined ? {} : { blocker }),
  actions: [],
  clientEnvironments: {},
  apply: () => Promise.resolve(undefined),
  readinessRemediation: () => undefined,
});

/** Plan packing, the optional agentenv install and the settings each registration lacks. */
export const planDesktopBuild = async (
  host: DesktopBuildSetupHost | undefined,
  options: Pick<SetupOptions, "desktopBuild" | "installAgentenv">,
  clientIds: readonly string[],
): Promise<DesktopBuildSetup> => {
  if (options.desktopBuild !== true) return inert();
  if (host === undefined)
    return inert("This setup host cannot set up desktop builds.");
  const facts = await host.facts(clientIds);
  const pinned = facts.agentEnvVersion === DESKTOP_EXPORT_FRAMEWORK_VERSION;
  const install = options.installAgentenv === true && !pinned;
  const uv = install ? facts.uv : undefined;
  const actions: SetupAction[] = [];
  if (uv !== undefined) actions.push(installAction(uv.agentEnv));
  // An archive the caller selected is recorded instead of packing REA's own.
  if (
    !facts.archivePacked &&
    !facts.selected.includes("REA_BUILD_COMPUTER_REA_ARCHIVE")
  ) {
    if (facts.packBlocker !== undefined) return inert(facts.packBlocker);
    actions.push(packAction(facts.archive));
  }
  const settings: SetupProviderEnvironment = {
    ...facts.settings,
    ...(uv !== undefined && !facts.selected.includes("REA_AGENT_ENV_COMMAND")
      ? { REA_AGENT_ENV_COMMAND: uv.agentEnv }
      : {}),
  };
  const remediation = agentenvRemediation(pinned, install, uv);
  return {
    selected: true,
    actions,
    clientEnvironments: Object.fromEntries(
      clientIds.map((client) => [
        client,
        Object.fromEntries(
          Object.entries(settings).filter(
            ([name]) =>
              facts.selected.includes(name) ||
              !(facts.recorded[client] ?? []).includes(name),
          ),
        ),
      ]),
    ),
    ...(remediation === undefined ? {} : { remediation }),
    apply: (appliedActions, onProgress) =>
      applyActions(host, actions, uv?.path, { appliedActions, onProgress }),
    readinessRemediation: (healthy) =>
      healthy
        ? undefined
        : `Run rea doctor --provider ${DESKTOP_BUILD_PROVIDER_ID} and apply each reported fix.`,
  };
};

const agentenvRemediation = (
  pinned: boolean,
  install: boolean,
  uv: DesktopBuildSetupFacts["uv"],
): string | undefined =>
  pinned || uv !== undefined
    ? undefined
    : install
      ? `uv is not on PATH. Install agentenv with ${AGENTENV_INSTALL_COMMAND}, then rerun setup.`
      : `Desktop builds need agentenv-framework ${DESKTOP_EXPORT_FRAMEWORK_VERSION}: ${AGENTENV_INSTALL_COMMAND}, or rerun setup with --install-agentenv.`;

const applyActions = async (
  host: DesktopBuildSetupHost,
  actions: readonly SetupAction[],
  uv: string | undefined,
  progress: {
    readonly appliedActions: string[];
    readonly onProgress?: ((event: SetupProgressEvent) => void) | undefined;
  },
): Promise<string | undefined> => {
  const failures: string[] = [];
  for (const { id, kind, label, target } of actions) {
    progress.onProgress?.({ actionId: id, label, state: "started" });
    const failure =
      kind === "install_agentenv"
        ? await host.installAgentenv(uv ?? "uv")
        : await host.packRuntime(target);
    progress.onProgress?.({
      actionId: id,
      label,
      state: failure === undefined ? "completed" : "failed",
      ...(failure === undefined ? {} : { detail: failure }),
    });
    if (failure === undefined) progress.appliedActions.push(id);
    else
      failures.push(
        kind === "install_agentenv"
          ? `Installing agentenv failed: ${failure} Run ${AGENTENV_INSTALL_COMMAND} yourself, then rerun setup.`
          : `Packing REA's build-computer runtime failed: ${failure} Fix the reported problem, then rerun setup with --desktop-build.`,
      );
  }
  return failures.length === 0 ? undefined : failures.join(" ");
};

const installAction = (agentEnv: string): SetupAction => ({
  id: "install_agentenv",
  kind: "install_agentenv",
  label: `agentenv-framework ${DESKTOP_EXPORT_FRAMEWORK_VERSION}`,
  target: agentEnv,
  detail:
    "Install the agentenv-framework release that desktop bundles target as a uv tool; REA runs its agent-env program for build computers.",
  external: true,
  operation: "install",
  networkOrigins: ["https://pypi.org", "https://files.pythonhosted.org"],
  commands: [AGENTENV_INSTALL_COMMAND],
});

const packAction = (archive: string): SetupAction => ({
  id: "pack_build_runtime",
  kind: "pack_build_runtime",
  label: "REA build-computer runtime",
  target: archive,
  detail:
    "Pack this REA checkout as the runtime a build computer installs: npm pack, its production dependencies from npm ci --omit=dev --omit=optional, then a .tar.xz named by this REA version, packed again when the version changes.",
  external: true,
  operation: "create",
  networkOrigins: ["https://registry.npmjs.org"],
  commands: [`npm run pack:build-computer-runtime -- ${archive}`],
});
