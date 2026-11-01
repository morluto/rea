import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { parseClientConfiguration } from "../../dist/application/ClientConfigurationDocument.js";
import { SUPPORTED_CLIENT_DEFINITIONS } from "../../dist/application/SupportedClients.js";
import { TOOL_CONTRACTS } from "../../dist/contracts/toolContracts.js";

/**
 * Real-model clients the agent evaluation can drive. Each one runs in an
 * isolated home configured only through public `rea setup`; only the caller's
 * authentication is reused.
 */
const CLIENTS = {
  codex: {
    setupClient: "codex",
    commandVariable: "REA_CODEX_CLI",
    defaultCommand: "codex",
    credentialFile: "auth.json",
  },
  "claude-code": {
    setupClient: "claude_code",
    commandVariable: "REA_VERIFY_CLAUDE_COMMAND",
    defaultCommand: "claude",
    credentialFile: ".credentials.json",
  },
  "gemini-cli": {
    setupClient: "gemini_cli",
    commandVariable: "REA_VERIFY_GEMINI_COMMAND",
    defaultCommand: "gemini",
    credentialFile: ".gemini/oauth_creds.json",
  },
};

const SKILL = "reverse-engineer-anything";

/**
 * Non-authentication controls a client receives for the version preflight as
 * well as every scenario: no self-update, no nonessential traffic, no relaunch.
 */
const CONTAINMENT = {
  codex: {},
  "claude-code": {
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  },
  "gemini-cli": { GEMINI_CLI_NO_RELAUNCH: "1" },
};

/** The selected client's containment variables, without any authentication. */
export const preflightClientEnvironment = (client) => ({
  ...CONTAINMENT[client.id],
});

/** Resolve `REA_AGENT_EVAL_CLIENT`; Codex remains the default. */
export const selectAgentEvalClient = (
  value = "codex",
  repositoryRoot = process.cwd(),
) => {
  const client = Object.hasOwn(CLIENTS, value) ? CLIENTS[value] : undefined;
  if (client === undefined)
    throw new Error(
      `REA_AGENT_EVAL_CLIENT must be one of ${Object.keys(CLIENTS).join(", ")}`,
    );
  const selected = process.env[client.commandVariable] ?? client.defaultCommand;
  // npm installs provide a JavaScript entry point; on Windows only a .cmd shim
  // reaches PATH, which Node does not spawn without a shell, so a selected .js
  // entry runs under this Node for the version preflight and every scenario.
  // It is resolved once against the repository root, because the preflight
  // runs from there and the scenarios from the evaluation root.
  const entryPoint = /\.(c|m)?js$/iu.test(selected)
    ? resolve(repositoryRoot, selected)
    : undefined;
  const command =
    entryPoint ??
    (selected.includes("/") || selected.includes("\\")
      ? resolve(repositoryRoot, selected)
      : selected);
  return {
    id: value,
    ...client,
    command,
    // Known before preparation, so a run that fails earlier still removes it.
    credentialPaths: (evaluationRoot) => [
      join(evaluationRoot, value, client.credentialFile),
    ],
    launch: (arguments_) =>
      entryPoint === undefined
        ? { command, arguments: [...arguments_] }
        : { command: process.execPath, arguments: [entryPoint, ...arguments_] },
  };
};

/**
 * Permission policy for a non-Codex client, taken from each tool's audited
 * effects: a tool that may run foreign code, change a device, discard caller
 * state, launch a process, or reach the network needs a scenario approval by
 * name. The MCP hints are display derivations of these same effects and are
 * not consulted, so changing a hint cannot change what a client may run.
 */
const permittedWithoutApproval = ({ effects }) =>
  !(
    effects.executesForeignCode ||
    effects.mutatesDevice ||
    effects.mayDiscardData ||
    effects.launchesProcess ||
    effects.accessesNetwork
  );

const allowedTools = (approvedTools) => [
  ...new Set([
    ...TOOL_CONTRACTS.filter(permittedWithoutApproval).map(({ name }) => name),
    ...approvedTools,
  ]),
];

const modelArguments = (model) =>
  model === undefined ? [] : ["--model", model];

const apiKeys = (...names) =>
  Object.fromEntries(
    names.flatMap((name) =>
      process.env[name] === undefined || process.env[name].length === 0
        ? []
        : [[name, process.env[name]]],
    ),
  );

/**
 * Caller variables a client may inherit: host, locale, temporary-directory,
 * network proxy, certificate, and session keyring access. Credentials and
 * configuration for every other tool are omitted; each client adds back only
 * its own API key.
 */
const INHERITED_ENVIRONMENT =
  /^(?:LANG|LANGUAGE|LC_[A-Z]+|TZ|TERM|USER|LOGNAME|SHELL|TMPDIR|TEMP|TMP|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|(?:HTTPS?|ALL|NO)_PROXY|SSL_CERT_(?:FILE|DIR)|NODE_EXTRA_CA_CERTS|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|APPDATA|LOCALAPPDATA)$/iu;

/** Build the disposable client environment from an allowlist. */
export const agentEvalEnvironment = ({ account, runId, client }) => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      INHERITED_ENVIRONMENT.test(name),
    ),
  ),
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
  HOME: account,
  USERPROFILE: account,
  XDG_CONFIG_HOME: join(account, ".config"),
  XDG_DATA_HOME: join(account, ".local/share"),
  XDG_CACHE_HOME: join(account, ".cache"),
  REA_PROCESS_RUN_ID: runId,
  ...client.environment,
});

/**
 * Copy one credential file. Its destination is registered for cleanup before
 * the copy starts; a missing source leaves environment authentication.
 */
const copyAuthentication = async (source, destination, authPaths) => {
  authPaths.push(destination);
  try {
    await copyFile(source, destination);
    await chmod(destination, 0o600);
  } catch (cause) {
    if (cause?.code !== "ENOENT") throw cause;
  }
};

const prepareCodex = async (
  profile,
  { evaluationRoot, account, model, authPaths },
) => {
  await copyAuthentication(
    join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json"),
    join(profile, "auth.json"),
    authPaths,
  );
  await writeFile(
    join(profile, "config.toml"),
    'approval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\n[features]\nmulti_agent = false\nshell_snapshot = false\n[history]\npersistence = "none"\n',
    { mode: 0o600 },
  );
  return {
    environment: {
      CODEX_HOME: profile,
      ...apiKeys("OPENAI_API_KEY", "CODEX_API_KEY"),
      // A caller-selected gateway travels with its credentials, as for the
      // other clients.
      ...(process.env.OPENAI_BASE_URL === undefined
        ? {}
        : { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL }),
    },
    // Codex has no own skill path and reads the shared agent skill root.
    skillDirectory: join(account, ".agents/skills", SKILL),
    arguments: (prompt, approvedTools) => [
      "--no-daemon",
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--json",
      "--color",
      "never",
      "-C",
      evaluationRoot,
      "-c",
      'approval_policy="never"',
      ...approvedTools.flatMap((name) => [
        "-c",
        `mcp_servers.rea.tools.${name}.approval_mode="approve"`,
      ]),
      ...modelArguments(model),
      prompt,
    ],
  };
};

const prepareClaudeCode = async (profile, { model, authPaths }) => {
  // An empty override counts as unset, as REA's own client resolver reads it.
  await copyAuthentication(
    join(
      process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      ".credentials.json",
    ),
    join(profile, ".credentials.json"),
    authPaths,
  );
  return claudeCodeClient(profile, model);
};

const claudeCodeClient = (profile, model) => ({
  environment: {
    CLAUDE_CONFIG_DIR: profile,
    ...CONTAINMENT["claude-code"],
    // Account-level claude.ai connectors are user configuration.
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    ...apiKeys("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"),
    ...(process.env.ANTHROPIC_BASE_URL === undefined
      ? {}
      : { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL }),
  },
  skillDirectory: join(profile, "skills", SKILL),
  arguments: (prompt, approvedTools) => [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--setting-sources",
    "user",
    // Read-only built-ins match the Codex read-only sandbox: no shell, edits,
    // web access, or subagents.
    "--tools",
    "Read,Grep,Glob,Skill,ToolSearch,WaitForMcpServers",
    "--permission-mode",
    "dontAsk",
    "--settings",
    JSON.stringify({
      permissions: {
        allow: [
          "Skill",
          "WaitForMcpServers",
          ...allowedTools(approvedTools).map((name) => `mcp__rea__${name}`),
        ],
      },
    }),
    ...modelArguments(model),
    prompt,
  ],
});

const geminiSettings = (selectedType) => ({
  security: { auth: { selectedType } },
  privacy: { usageStatisticsEnabled: false },
  telemetry: { enabled: false },
});

/**
 * Reuse only the caller's selected authentication type. Gemini CLI can keep
 * the credential itself outside its settings directory, such as an API key in
 * the OS keychain.
 */
const GEMINI_SETTINGS_FORMAT = SUPPORTED_CLIENT_DEFINITIONS.find(
  ({ name }) => name === "gemini_cli",
)?.format;

const callerGeminiAuthType = async (geminiDirectory) => {
  try {
    const contents = await readFile(
      join(geminiDirectory, "settings.json"),
      "utf8",
    );
    // The owning parser reads the file as REA's setup does: BOM-tolerant
    // JSONC, with an empty placeholder file holding no settings.
    const { document } = parseClientConfiguration(
      contents,
      GEMINI_SETTINGS_FORMAT,
    );
    const selected = document.security?.auth?.selectedType;
    return typeof selected === "string" ? selected : undefined;
  } catch (cause) {
    if (cause?.code === "ENOENT") return undefined;
    throw cause;
  }
};

const prepareGeminiCli = async (profile, { model, authPaths }) => {
  const gemini = join(profile, ".gemini");
  await mkdir(gemini, { mode: 0o700 });
  const callerGemini = join(
    process.env.GEMINI_CLI_HOME || homedir(),
    ".gemini",
  );
  // An explicit API key wins; otherwise the caller's selected type is reused.
  const authType = !process.env.GEMINI_API_KEY
    ? ((await callerGeminiAuthType(callerGemini)) ?? "oauth-personal")
    : "gemini-api-key";
  if (authType === "oauth-personal")
    await copyAuthentication(
      join(callerGemini, "oauth_creds.json"),
      join(gemini, "oauth_creds.json"),
      authPaths,
    );
  const empty = join(profile, "empty-settings.json");
  const policy = join(profile, "rea-evaluation-policy.toml");
  await writeFile(empty, "{}\n", { mode: 0o600 });
  await writeFile(
    join(gemini, "settings.json"),
    `${JSON.stringify(geminiSettings(authType), null, 2)}\n`,
    { mode: 0o600 },
  );
  return {
    environment: {
      GEMINI_CLI_HOME: profile,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: empty,
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: empty,
      ...CONTAINMENT["gemini-cli"],
      GEMINI_CLI_TRUST_WORKSPACE: "true",
      ...apiKeys("GEMINI_API_KEY"),
      ...(process.env.GOOGLE_GEMINI_BASE_URL === undefined
        ? {}
        : { GOOGLE_GEMINI_BASE_URL: process.env.GOOGLE_GEMINI_BASE_URL }),
    },
    skillDirectory: join(profile, ".agents/skills", SKILL),
    arguments: async (prompt, approvedTools) => {
      await writeFile(
        policy,
        [
          // Headless mode otherwise refuses skill activation, which the
          // installed REA skill needs; Claude Code allows `Skill` likewise.
          '[[rule]]\ntoolName = "activate_skill"\ndecision = "allow"\npriority = 100\n',
          ...allowedTools(approvedTools).map(
            (name) =>
              `[[rule]]\nmcpName = "rea"\ntoolName = "${name}"\ndecision = "allow"\npriority = 100\n`,
          ),
        ].join("\n"),
        { mode: 0o600 },
      );
      return [
        // Headless default mode refuses shell and edit tools needing approval.
        "--approval-mode",
        "default",
        "--policy",
        policy,
        "--allowed-mcp-server-names",
        "rea",
        "--output-format",
        "stream-json",
        ...modelArguments(model),
        "--prompt",
        prompt,
      ];
    },
  };
};

const PREPARERS = {
  codex: prepareCodex,
  "claude-code": prepareClaudeCode,
  "gemini-cli": prepareGeminiCli,
};

/**
 * Prepare one client's isolated profile below `evaluationRoot`. Copied
 * credential files are appended to the caller-owned `authPaths` before they
 * are written. Returns the environment additions, the installed skill
 * directory, and the client's spawn arguments.
 */
export const prepareAgentEvalClient = async (client, options) => {
  const profile = join(options.evaluationRoot, client.id);
  await mkdir(profile, { mode: 0o700 });
  return PREPARERS[client.id](profile, options);
};
