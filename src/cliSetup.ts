import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  outro,
} from "@clack/prompts";

import type {
  SetupAction,
  SetupConfirmationDecision,
  SetupProgressEvent,
  SetupResult,
} from "./application/Setup.js";
import { SUPPORTED_CLIENT_DEFINITIONS } from "./application/SupportedClients.js";

const clientDisplayNames: ReadonlyMap<string, string> = new Map(
  SUPPORTED_CLIENT_DEFINITIONS.map(({ name, displayName }) => [
    name,
    displayName,
  ]),
);

const promptStreams = {
  input: process.stdin,
  output: process.stderr,
  withGuide: true,
} as const;

const agentAccessCapabilityId = "agent_access";

interface SetupCapability {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
}

/** Run the inline setup picker, exact preflight, and default-No consent. */
export const confirmInteractiveSetup = async (
  actions: readonly SetupAction[],
  accessible: boolean,
): Promise<SetupConfirmationDecision> => {
  intro("REA setup", promptStreams);
  renderValueIntroduction();
  renderDetectedSummary(actions);
  renderKeyboardHelp(accessible);
  const selectedActionIds = await selectSetupActions(actions, accessible);
  if (selectedActionIds === undefined) return cancelledDecision();
  if (selectedActionIds.length === 0) {
    cancel("Nothing selected. No changes were made.", promptStreams);
    return { approved: false, selectedActionIds };
  }
  const selected = new Set(selectedActionIds);
  const selectedActions = actions.filter(({ id }) => selected.has(id));
  renderPreflight(selectedActions);
  const approved = await confirm({
    ...promptStreams,
    message:
      selectedActions.length === 1
        ? "Apply this change?"
        : `Apply these ${String(selectedActions.length)} changes?`,
    initialValue: false,
    active: "Yes, apply",
    inactive: "No, cancel",
  });
  if (isCancel(approved) || !approved) {
    cancel("Setup cancelled. No changes were made.", promptStreams);
    return { approved: false, selectedActionIds };
  }
  return { approved: true, selectedActionIds };
};

/** Render stable, append-only progress for real setup operations. */
export const renderSetupProgress = (event: SetupProgressEvent): void => {
  const symbol =
    event.state === "started"
      ? "◇"
      : event.state === "completed"
        ? "◆"
        : event.state === "warning"
          ? "!"
          : "✗";
  const suffix = event.detail === undefined ? "" : ` · ${event.detail}`;
  writeLine(`${symbol}  ${event.label}${suffix}`);
};

/** Finish an interactive setup journey without exposing the full doctor catalog. */
export const renderInteractiveSetupResult = (result: SetupResult): void => {
  if (result.status === "ready") {
    const changedClients = Object.entries(result.clients)
      .filter(([, client]) => client.status === "configured")
      .map(([client]) => clientDisplayNames.get(client) ?? client);
    const readyClients = readyAgentClients(result, changedClients);
    renderReadyCapabilities(result, readyClients);
    outro(
      changedClients.length === 0
        ? "REA is ready for local app analysis."
        : `Restart ${changedClients.join(", ")} to load REA.`,
      promptStreams,
    );
    return;
  }
  if (result.status === "planned") return;
  writeLine(`!  ${result.remediation ?? "Setup needs attention."}`);
  outro("Run `rea doctor` for the remaining checks.", promptStreams);
};

/** Keep default non-TTY output actionable without emitting the full catalog. */
export const conciseSetupResult = (result: SetupResult) => ({
  status: result.status,
  plannedActions: result.plannedActions,
  appliedActions: result.appliedActions,
  clients: result.clients,
  doctor: {
    healthy: result.doctor.healthy,
    checks: result.doctor.checks.filter(({ ok }) => !ok),
  },
  ...(result.code === undefined ? {} : { code: result.code }),
  ...(result.remediation === undefined
    ? {}
    : { remediation: result.remediation }),
});

const selectSetupActions = async (
  actions: readonly SetupAction[],
  accessible: boolean,
): Promise<readonly string[] | undefined> => {
  const clientActions = actions.filter(
    ({ kind }) => kind === "configure_client",
  );
  const componentActions = actions.filter(
    ({ kind }) => kind !== "configure_client",
  );
  const capabilities = setupCapabilities(clientActions, componentActions);
  const selectedCapabilities = accessible
    ? await selectCapabilitiesAccessibly(capabilities)
    : await selectCapabilities(capabilities);
  if (selectedCapabilities === undefined) return undefined;
  const selectedCapabilityIds = new Set(selectedCapabilities);
  const selectedActionIds = componentActions
    .filter(({ id }) => selectedCapabilityIds.has(id))
    .map(({ id }) => id);
  if (!selectedCapabilityIds.has(agentAccessCapabilityId))
    return selectedActionIds;
  const selectedClients = accessible
    ? await selectClientsAccessibly(clientActions)
    : await selectClients(clientActions);
  return selectedClients === undefined
    ? undefined
    : [...selectedClients, ...selectedActionIds];
};

const setupCapabilities = (
  clientActions: readonly SetupAction[],
  componentActions: readonly SetupAction[],
): readonly SetupCapability[] => [
  ...(clientActions.length === 0
    ? []
    : [
        {
          id: agentAccessCapabilityId,
          label: "Coding-agent access (MCP)",
          hint: `${String(clientActions.length)} detected ${clientActions.length === 1 ? "agent" : "agents"}`,
        },
      ]),
  ...componentActions.map((action) => ({
    id: action.id,
    label: `${action.label} (${actionModality(action)})`,
    hint: `${action.operation} · ${action.target}`,
  })),
];

const selectCapabilities = async (
  capabilities: readonly SetupCapability[],
): Promise<readonly string[] | undefined> => {
  const selection = await multiselect({
    ...promptStreams,
    message: "What should REA set up?",
    options: capabilities.map((capability) => ({
      value: capability.id,
      label: capability.label,
      hint: capability.hint,
    })),
    required: false,
    maxItems: Math.max(
      3,
      Math.min(capabilities.length, (process.stderr.rows ?? 24) - 8),
    ),
    showInstructions: true,
  });
  return isCancel(selection) ? undefined : selection;
};

const selectCapabilitiesAccessibly = async (
  capabilities: readonly SetupCapability[],
): Promise<readonly string[] | undefined> => {
  const selected: string[] = [];
  for (const capability of capabilities) {
    const included = await confirm({
      ...promptStreams,
      message: `Set up ${capability.label}? ${capability.hint}`,
      initialValue: false,
      vertical: true,
    });
    if (isCancel(included)) return undefined;
    if (included) selected.push(capability.id);
  }
  return selected;
};

const selectClients = async (
  actions: readonly SetupAction[],
): Promise<readonly string[] | undefined> => {
  const selection = await multiselect({
    ...promptStreams,
    message: "Which agents should use REA?",
    options: actions.map((action) => ({
      value: action.id,
      label: `${action.label} (detected)`,
      hint: `${action.operation} · ${action.target}`,
    })),
    required: false,
    maxItems: Math.max(
      3,
      Math.min(actions.length, (process.stderr.rows ?? 24) - 8),
    ),
    showInstructions: true,
  });
  return isCancel(selection) ? undefined : selection;
};

const selectClientsAccessibly = async (
  actions: readonly SetupAction[],
): Promise<readonly string[] | undefined> => {
  const selected: string[] = [];
  for (const action of actions) {
    const included = await confirm({
      ...promptStreams,
      message: `Configure ${action.label}? ${action.target}`,
      initialValue: false,
      vertical: true,
    });
    if (isCancel(included)) return undefined;
    if (included) selected.push(action.id);
  }
  return selected;
};

const renderValueIntroduction = (): void => {
  writeLine("│  Understand local apps and binaries from your coding agent.");
  writeLine("│");
  writeLine("│  • Trace how a feature works with local evidence.");
  writeLine(
    "│  • Use the same analysis capabilities from REA's CLI and supported agents.",
  );
  writeLine(
    "│  • Keep analyzed targets on this machine instead of uploading them to a hosted service.",
  );
};

const renderDetectedSummary = (actions: readonly SetupAction[]): void => {
  const clients = actions.filter(({ kind }) => kind === "configure_client");
  writeLine("│");
  if (clients.length === 0) {
    writeLine("◆  No agent integrations need configuration");
  } else {
    writeLine(
      `◆  Found ${String(clients.length)} supported ${clients.length === 1 ? "agent" : "agents"}`,
    );
    writeLine(`│  ${humanList(clients.map(({ label }) => label))}`);
  }
};

const renderKeyboardHelp = (accessible: boolean): void => {
  writeLine("│");
  writeLine(
    accessible
      ? "│  Keys: Enter answer · Ctrl-C cancel"
      : "│  Keys: ↑/↓ navigate · Space toggle · Enter confirm · Ctrl-C cancel",
  );
};

const renderReadyCapabilities = (
  result: SetupResult,
  readyClients: readonly string[],
): void => {
  writeLine("◆  What you can do now");
  const providers = readyProviders(result);
  if (providers.length > 0)
    writeLine(`│  Deep analysis: ${humanList(providers)}`);
  if (readyClients.length > 0)
    writeLine(`│  Agent access: ${humanList(readyClients)}`);
  if (result.doctor.identity?.skill.state === "aligned")
    writeLine("│  Guided reverse-engineering workflows: installed");
  if (providers.length > 0) writeLine("│  CLI: rea analyze /path/to/app");
  const firstClient = readyClients[0];
  if (firstClient !== undefined)
    writeLine(
      `│  Try in ${firstClient}: "Use REA to explain how a feature works in /path/to/app."`,
    );
};

const readyAgentClients = (
  result: SetupResult,
  changedClients: readonly string[],
): readonly string[] => {
  const alignedClients = (result.doctor.identity?.registrations ?? [])
    .filter(({ state }) => state === "aligned")
    .map(({ client }) => clientDisplayNames.get(client) ?? client);
  return [...new Set([...alignedClients, ...changedClients])];
};

const readyProviders = (result: SetupResult): readonly string[] => {
  const providers = [
    ...(result.doctor.hopperPath === undefined ? [] : ["Hopper"]),
    ...(result.doctor.providerInspections ?? [])
      .filter(({ available }) => available)
      .map(({ id }) => displayProviderId(id)),
  ];
  return [...new Set(providers)];
};

const displayProviderId = (id: string): string =>
  id.length === 0 ? id : `${id[0]?.toUpperCase() ?? ""}${id.slice(1)}`;

const actionModality = (action: SetupAction): string => {
  if (action.kind === "configure_client") return "MCP";
  if (action.kind === "install_hopper") return "provider";
  return "skill";
};

const humanList = (values: readonly string[]): string => {
  if (values.length < 2) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
};

const renderPreflight = (actions: readonly SetupAction[]): void => {
  writeLine("│");
  writeLine("◆  Ready to review");
  for (const action of actions) {
    writeLine("│");
    writeLine(`│  ${action.operation.toUpperCase()}  ${action.label}`);
    writeLine(`│          ${action.target}`);
    if (action.backupPath !== undefined)
      writeLine(`│          backup: ${action.backupPath}`);
    for (const origin of action.networkOrigins ?? [])
      writeLine(`│          network: ${origin}`);
    if (action.integrity !== undefined)
      writeLine(`│          integrity: ${action.integrity}`);
    for (const command of action.commands ?? [])
      writeLine(`│          command: ${command}`);
    writeLine(`│          ${action.detail}`);
    if (action.external) writeLine("│          external software");
  }
  writeLine("│");
  writeLine(
    "│  REA will preserve unrelated configuration and will not install or upgrade Node.js, npm, Homebrew, Java, or Ghidra.",
  );
};

const cancelledDecision = (): SetupConfirmationDecision => {
  cancel("Setup cancelled. No changes were made.", promptStreams);
  return {
    approved: false,
    selectedActionIds: [],
  };
};

const writeLine = (line: string): void => {
  process.stderr.write(`${line}\n`);
};
