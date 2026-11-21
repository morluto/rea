import { err, ok, type Result } from "./domain/result.js";

/** Global output flags that take a value. */
export const VALUED_OUTPUT_FLAGS: ReadonlySet<string> = new Set([
  "--format",
  "--filter-output",
  "--columns",
  "--token-limit",
  "--token-offset",
]);

const spacedOutputValue = (
  flag: string,
  next: string | undefined,
): string | undefined =>
  VALUED_OUTPUT_FLAGS.has(flag) && next ? next : undefined;

export const OUTPUT_SWITCHES: ReadonlySet<string> = new Set([
  "--json",
  "--full-output",
  "--token-count",
  "--timings",
]);

/** Valueless global flags taken out of every position before command parsing. */
export const CLI_BUILTIN_FLAGS: ReadonlySet<string> = new Set([
  "--full-output",
  "--llms",
  "--llms-full",
  "--mcp",
  "--help",
  "-h",
  "--update",
  // The detached update check's own flag.
  "--incur-update-check",
  "--schema",
  "--json",
  "--token-count",
  "--timings",
]);

/** The timing global's spellings: `--timings`, `--no-timings`, `--timings=<text>`. */
const cliTimingFlagValue = (token: string): boolean | undefined =>
  token === "--timings"
    ? true
    : token === "--no-timings"
      ? false
      : token.startsWith("--timings=")
        ? token.slice("--timings=".length) === "true"
        : undefined;

/**
 * One invocation's global arguments, read once from the caller's argv.
 * Consumers read these facts instead of scanning argv again.
 */
export interface CliGlobalArguments {
  /**
   * The caller's arguments with valued output flags in spaced form and a root
   * `--update` routed to `update`. The positions below index into this list.
   */
  readonly arguments: readonly string[];
  /** Tokens left for command resolution and command option parsing. */
  readonly command: readonly string[];
  /** Argument position of each `command` token. */
  readonly commandIndices: readonly number[];
  /** Valueless global flags and timing spellings taken out before command parsing. */
  readonly flags: ReadonlySet<string>;
  /** Positions of nonempty values consumed by valued output flags. */
  readonly outputValues: readonly {
    readonly flag: string;
    readonly index: number;
  }[];
  /** Positions of the timing spellings in `flags`. */
  readonly timingIndices: readonly number[];
  /** The timing global's value; the last spelling wins. */
  readonly timings: boolean;
}

/**
 * Route the root update alias and split `--flag=value` output forms. Command
 * options accept both forms; the global split below reads the spaced one.
 */
const normalizeCliArguments = (arguments_: readonly string[]): string[] => {
  const normalized: string[] = [];
  const updates = new Set<number>();
  let rootUpdate = true;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    const outputValue = spacedOutputValue(argument, arguments_[index + 1]);
    if (outputValue !== undefined) {
      // A nonempty spaced value is consumed before looking for more flags.
      // Its contents belong to that option, even when they look like a flag.
      normalized.push(argument, outputValue);
      index += 1;
      continue;
    }
    const separator = argument.indexOf("=");
    const flag = argument.slice(0, separator);
    if (separator >= 0 && VALUED_OUTPUT_FLAGS.has(flag))
      normalized.push(flag, argument.slice(separator + 1));
    else {
      if (argument === "--update") updates.add(normalized.length);
      else if (
        !OUTPUT_SWITCHES.has(argument) &&
        cliTimingFlagValue(argument) === undefined
      )
        rootUpdate = false;
      normalized.push(argument);
    }
  }
  // Output option values were consumed above; flag-shaped data is never an alias.
  // Help/check/command/unknown tokens keep their own parsing and precedence.
  return rootUpdate && updates.size > 0
    ? ["update", ...normalized.filter((_, index) => !updates.has(index))]
    : normalized;
};

/**
 * Read one invocation's global arguments. Builtin switches are taken from any
 * position, including after `--`; a valued output flag consumes the next
 * nonempty token as data. The timing global is then read from the remaining
 * tokens until `--`. The output argument reader reports malformed output
 * values from these same positions.
 */
export const parseCliGlobalArguments = (
  arguments_: readonly string[],
): CliGlobalArguments => {
  const normalized = normalizeCliArguments(arguments_);
  const command: string[] = [];
  const commandIndices: number[] = [];
  const flags = new Set<string>();
  const outputValues: { readonly flag: string; readonly index: number }[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const argument = normalized[index]!;
    const next = normalized[index + 1];
    if (
      (CLI_BUILTIN_FLAGS.has(argument) && argument !== "--timings") ||
      // A following value belongs to a command-local `--version` option.
      (argument === "--version" && (next === undefined || next.startsWith("-")))
    ) {
      flags.add(argument);
      continue;
    }
    if (spacedOutputValue(argument, next) !== undefined) {
      outputValues.push({ flag: argument, index: index + 1 });
      index += 1;
      continue;
    }
    command.push(argument);
    commandIndices.push(index);
  }
  // A timing-shaped output value is data; a command option's value is still
  // read by this global pass before the command parser sees it.
  let globalsEnded = false;
  let timings = false;
  const remaining: string[] = [];
  const remainingIndices: number[] = [];
  const timingIndices: number[] = [];
  command.forEach((token, position) => {
    if (token === "--") globalsEnded = true;
    const value = globalsEnded ? undefined : cliTimingFlagValue(token);
    if (value === undefined) {
      remaining.push(token);
      remainingIndices.push(commandIndices[position]!);
      return;
    }
    flags.add(token);
    timings = value;
    timingIndices.push(commandIndices[position]!);
  });
  return {
    arguments: normalized,
    command: remaining,
    commandIndices: remainingIndices,
    flags,
    outputValues,
    timingIndices,
    timings,
  };
};

type McpAddArgumentError =
  | {
      readonly kind: "missing_value";
      readonly flag: string;
      readonly field: "agent" | "command";
    }
  | { readonly kind: "unexpected_argument"; readonly token: string };

/**
 * Own token consumption for the REA registration operation. Agent selection
 * remains observable even for invalid input so the launcher's scope refusal
 * and dispatch cannot interpret a command value as an agent selector.
 */
export const readMcpAddArguments = (
  command: CliGlobalArguments["command"],
): {
  readonly agents: readonly string[];
  readonly commandText: string | undefined;
  readonly global: boolean;
  readonly validation: Result<void, McpAddArgumentError>;
} => {
  const agents: string[] = [];
  let commandText: string | undefined;
  let global = true;
  let missing: McpAddArgumentError | undefined;
  let unexpected: McpAddArgumentError | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const token = command[index]!;
    const flag = token.split("=", 1)[0]!;
    if (flag === "--agent" || flag === "--command" || flag === "-c") {
      const equals = token.indexOf("=");
      const value = equals < 0 ? command[++index] : token.slice(equals + 1);
      // Spaced flags cannot satisfy another option's missing value. Equals
      // values remain caller-selected data, including a leading dash.
      if (
        value === undefined ||
        value === "" ||
        (equals < 0 && value.startsWith("-"))
      )
        missing ??= {
          kind: "missing_value",
          flag,
          field: flag === "--agent" ? "agent" : "command",
        };
      if (flag === "--agent" && value) agents.push(value);
      if (flag === "--command" || flag === "-c") commandText = value;
    } else if (token === "--no-global") global = false;
    else unexpected ??= { kind: "unexpected_argument", token };
  }
  const failure = missing ?? unexpected;
  return {
    agents,
    commandText,
    global,
    validation: failure === undefined ? ok(undefined) : err(failure),
  };
};

/**
 * How `mcp add` answers a request instead of registering it. Single owner
 * for the discovery flags: the Amp-scope guard and the `mcp add` routing in
 * `cli.ts` both consume this classification, so a new discovery switch
 * cannot diverge between the guard and the routing. Precedence matches the
 * routing: bypass flags skip the `mcp add` special-casing entirely, and
 * version beats schema inside it.
 */
export type McpAddDiscoveryHandling = "bypass" | "version" | "schema";

export const classifyMcpAddDiscovery = (
  flags: ReadonlySet<string>,
): McpAddDiscoveryHandling | undefined => {
  if (
    flags.has("--help") ||
    flags.has("-h") ||
    flags.has("--llms") ||
    flags.has("--llms-full") ||
    flags.has("--mcp") ||
    flags.has("--update") ||
    flags.has("--incur-update-check")
  )
    return "bypass";
  if (flags.has("--version")) return "version";
  if (flags.has("--schema")) return "schema";
  return undefined;
};

/** The lightweight launcher and full dispatcher share the same parsed scope fact. */
export const isProjectScopedAmpRegistration = ({
  command,
  flags,
}: CliGlobalArguments): boolean => {
  if (command[0] !== "mcp" || command[1] !== "add") return false;
  if (classifyMcpAddDiscovery(flags) !== undefined) return false;
  const rest = command.slice(2);
  const { agents, global } = readMcpAddArguments(rest);
  return !global && (agents.length === 0 || agents.includes("amp"));
};

/**
 * The arguments production `mcp doctor` parses itself: the caller's, without
 * the `mcp doctor` words and the timing global the launcher measures. Returns
 * undefined for any other command.
 */
const productionMcpDoctorArguments = (
  arguments_: readonly string[],
):
  | { readonly arguments: readonly string[]; readonly timings: boolean }
  | undefined => {
  const global = parseCliGlobalArguments(arguments_);
  if (
    global.command[0] !== "mcp" ||
    global.command[1] !== "doctor" ||
    global.flags.has("--mcp")
  )
    return undefined;
  const removed = new Set([
    global.commandIndices[0]!,
    global.commandIndices[1]!,
    ...global.timingIndices,
  ]);
  return {
    arguments: global.arguments.filter((_, index) => !removed.has(index)),
    timings: global.timings,
  };
};

/** The command parser accepts the schema key and its kebab-case spelling. */
const FLAGS = ["--sensitive-value", "--sensitiveValue"] as const;

/**
 * Read declarations from the tokens left for command parsing. The command
 * parser rejects a malformed token before it reaches later declarations, so
 * this scan is independent of parse success. A token following a declaration
 * flag counts as declared even where the command parser would bind it to
 * another option.
 */
export const declaredSensitiveValues = (
  command: CliGlobalArguments["command"],
): readonly string[] => {
  const values = new Set<string>();
  for (let index = 0; index < command.length; index += 1) {
    const token = command[index]!;
    const flag = FLAGS.find(
      (candidate) => token === candidate || token.startsWith(`${candidate}=`),
    );
    if (flag === undefined) continue;
    if (token !== flag) values.add(token.slice(flag.length + 1));
    else if (index + 1 < command.length) {
      values.add(command[index + 1]!);
      index += 1;
    }
  }
  values.delete("");
  return [...values];
};
/** Shell completion is a transport protocol; its words are not CLI invocations. */
export const CLI_COMPLETION_SHELLS = [
  "bash",
  "zsh",
  "fish",
  "nushell",
] as const;
export const cliCompletionShell = (environment: Readonly<NodeJS.ProcessEnv>) =>
  CLI_COMPLETION_SHELLS.find((shell) => shell === environment.COMPLETE);

type McpHttpCommandProblem =
  | { readonly kind: "help" }
  | { readonly kind: "invalid"; readonly message: string };

export type McpHttpCommand =
  | McpHttpCommandProblem
  | {
      readonly kind: "listen";
      readonly host: string | undefined;
      readonly port: string | undefined;
      readonly allowedHosts: readonly string[];
    };

const invalidMcpHttpCommand = (message: string): McpHttpCommandProblem => ({
  kind: "invalid",
  message,
});

const MCP_HTTP_VALUED_FLAGS: ReadonlySet<string> = new Set([
  "--host",
  "--port",
  "--allowed-hosts",
]);

const MCP_HTTP_HELP_FLAGS: ReadonlySet<string> = new Set(["--help", "-h"]);

const readMcpHttpOption = (argument: string, next: string | undefined) => {
  const separator = argument.indexOf("=");
  return separator === -1
    ? {
        flag: argument,
        inline: false,
        value: next?.startsWith("-") ? undefined : next,
      }
    : {
        flag: argument.slice(0, separator),
        inline: true,
        value: argument.slice(separator + 1),
      };
};

/** Read the transport syntax once, retaining the first help or refusal while looking for the mode. */
const readMcpHttpCommand = (
  arguments_: readonly string[],
): McpHttpCommand | undefined => {
  let mode: "explicit" | "required" | undefined;
  const values = new Map<string, string>();
  const allowedHosts: string[] = [];
  let problem: McpHttpCommandProblem | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (MCP_HTTP_HELP_FLAGS.has(argument)) {
      problem ??= { kind: "help" };
      continue;
    }
    if (argument === "--http") {
      mode = "explicit";
      continue;
    }
    const next = arguments_[index + 1];
    const { flag, inline, value } = readMcpHttpOption(argument, next);
    if (MCP_HTTP_VALUED_FLAGS.has(flag)) {
      mode ??= "required";
      if (value === undefined) {
        problem ??= invalidMcpHttpCommand(`Missing value for ${flag}`);
      } else {
        if (flag === "--allowed-hosts") allowedHosts.push(value);
        else values.set(flag, value);
        if (!inline) index += 1;
      }
      continue;
    }
    problem ??= invalidMcpHttpCommand(
      `Unknown mcp --http argument: ${argument}`,
    );
    // A subcommand or an option delimiter ends mode selection. Global
    // output values belong to the one-shot CLI even if they spell --http.
    if (!argument.startsWith("-") || argument === "--") break;
    if (!inline && spacedOutputValue(flag, next) !== undefined) index += 1;
  }
  if (mode === undefined) return undefined;
  if (problem !== undefined) return problem;
  if (mode === "required")
    return invalidMcpHttpCommand("--host and --port require --http");
  return {
    kind: "listen",
    host: values.get("--host"),
    port: values.get("--port"),
    allowedHosts,
  };
};

type CliEntrypoint =
  | { readonly kind: "cli" | "mcp-stdio" }
  | { readonly kind: "mcp-http"; readonly command: McpHttpCommand }
  | {
      readonly kind: "mcp-doctor";
      readonly arguments: readonly string[];
      readonly timings: boolean;
    };

/** Select the process entry before loading its runtime, including completion requests. */
export const classifyCliEntrypoint = (
  arguments_: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
): CliEntrypoint => {
  if (cliCompletionShell(environment) !== undefined) return { kind: "cli" };
  const entry = arguments_[0];
  if (entry === "mcp" || entry === "--mcp") {
    if (arguments_.length === 1) return { kind: "mcp-stdio" };
    const command = readMcpHttpCommand(arguments_.slice(1));
    if (command !== undefined) return { kind: "mcp-http", command };
  }
  const doctor = productionMcpDoctorArguments(arguments_);
  return doctor === undefined
    ? { kind: "cli" }
    : { kind: "mcp-doctor", ...doctor };
};
