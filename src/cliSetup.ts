import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  outro,
  select,
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

type SetupMode = "recommended" | "custom" | "skip";

/** Run the inline setup picker, exact preflight, and default-No consent. */
export const confirmInteractiveSetup = async (
  actions: readonly SetupAction[],
  accessible: boolean,
): Promise<SetupConfirmationDecision> => {
  intro("REA setup", promptStreams);
  renderValueIntroduction();
  renderDetectedSummary(actions);
  renderKeyboardHelp(accessible);
  const mode = await selectSetupMode(actions, accessible);
  if (mode === undefined) return cancelledDecision(actions);
  if (mode === "skip") {
    cancel("No changes were made.", promptStreams);
    return {
      approved: false,
      selectedActionIds: actions.map(({ id }) => id),
    };
  }
  const selectedActionIds =
    mode === "recommended"
      ? actions.map(({ id }) => id)
      : accessible
        ? await selectActionsAccessibly(actions)
        : await selectActions(actions);
  if (selectedActionIds === undefined) return cancelledDecision(actions);
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

const selectActions = async (
  actions: readonly SetupAction[],
): Promise<readonly string[] | undefined> => {
  const selection = await multiselect({
    ...promptStreams,
    message: "Choose what REA should configure",
    options: actions.map((action) => ({
      value: action.id,
      label: `${action.label} (${actionModality(action)})`,
      hint: `${action.operation} · ${action.target}`,
    })),
    initialValues: actions.map(({ id }) => id),
    required: false,
    maxItems: Math.max(
      3,
      Math.min(actions.length, (process.stderr.rows ?? 24) - 8),
    ),
    showInstructions: true,
  });
  return isCancel(selection) ? undefined : selection;
};

const selectActionsAccessibly = async (
  actions: readonly SetupAction[],
): Promise<readonly string[] | undefined> => {
  const selected: string[] = [];
  for (const action of actions) {
    const included = await confirm({
      ...promptStreams,
      message: `Include ${action.label} (${actionModality(action)})? ${action.target}`,
      initialValue: true,
      vertical: true,
    });
    if (isCancel(included)) return undefined;
    if (included) selected.push(action.id);
  }
  return selected;
};

const selectSetupMode = async (
  actions: readonly SetupAction[],
  accessible: boolean,
): Promise<SetupMode | undefined> => {
  if (accessible) return selectSetupModeAccessibly();
  const mode = await select<SetupMode>({
    ...promptStreams,
    message: "Choose a setup",
    options: [
      {
        value: "recommended",
        label: "Set up all available capabilities",
        hint: `recommended · ${actionCount(actions.length)}`,
      },
      {
        value: "custom",
        label: "Customize setup",
        hint: "choose integrations and components",
      },
      {
        value: "skip",
        label: "No thanks",
        hint: "make no changes",
      },
    ],
    initialValue: "recommended",
  });
  return isCancel(mode) ? undefined : mode;
};

const selectSetupModeAccessibly = async (): Promise<SetupMode | undefined> => {
  const recommended = await confirm({
    ...promptStreams,
    message: "Use the recommended complete setup?",
    initialValue: true,
    vertical: true,
  });
  if (isCancel(recommended)) return undefined;
  if (recommended) return "recommended";
  const customize = await confirm({
    ...promptStreams,
    message: "Customize integrations and components?",
    initialValue: true,
    vertical: true,
  });
  if (isCancel(customize)) return undefined;
  return customize ? "custom" : "skip";
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
    writeLine(`◆  Detected ${humanList(clients.map(({ label }) => label))}`);
    for (const client of clients) {
      writeLine(
        `│  ${client.label} · ${actionModality(client)} · ${client.operation}`,
      );
      writeLine(`│  ${client.target}`);
    }
  }
  const components = actions.filter(({ kind }) => kind !== "configure_client");
  if (components.length > 0) {
    writeLine("│");
    writeLine(
      `│  Also available: ${components.map((action) => `${action.label} (${actionModality(action)})`).join(", ")}`,
    );
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

const actionCount = (count: number): string =>
  `${String(count)} ${count === 1 ? "change" : "changes"}`;

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

const cancelledDecision = (
  actions: readonly SetupAction[],
): SetupConfirmationDecision => {
  cancel("Setup cancelled. No changes were made.", promptStreams);
  return {
    approved: false,
    selectedActionIds: actions.map(({ id }) => id),
  };
};

const writeLine = (line: string): void => {
  process.stderr.write(`${line}\n`);
};
