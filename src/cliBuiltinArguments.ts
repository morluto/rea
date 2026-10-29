/** Global output flags that take a value. */
export const VALUED_OUTPUT_FLAGS: ReadonlySet<string> = new Set([
  "--format",
  "--filter-output",
  "--columns",
  "--token-limit",
  "--token-offset",
]);

export const OUTPUT_SWITCHES: ReadonlySet<string> = new Set([
  "--json",
  "--full-output",
  "--token-count",
  "--timings",
]);

/** Valueless flags Incur removes from every position before command parsing. */
export const INCUR_BUILTIN_FLAGS: ReadonlySet<string> = new Set([
  "--full-output",
  "--llms",
  "--llms-full",
  "--mcp",
  "--help",
  "-h",
  "--update",
  // Incur's internal update-check flag.
  "--incur-update-check",
  "--schema",
  "--json",
  "--token-count",
  "--timings",
]);

/** Supported boolean spelling under the pinned Incur global parser. */
const cliTimingFlagValue = (token: string): boolean | undefined =>
  token === "--timings"
    ? true
    : token === "--no-timings"
      ? false
      : token.startsWith("--timings=")
        ? token.slice("--timings=".length) === "true"
        : undefined;

/** Remove only timing globals, preserving valued output data and the -- boundary. */
export const splitCliTimingArguments = (
  arguments_: readonly string[],
): { arguments: string[]; enabled: boolean } => {
  const values = new Set(
    splitIncurBuiltinArguments(arguments_).outputValues.map(
      ({ index }) => index,
    ),
  );
  let enabled = false;
  let ended = false;
  const remaining = arguments_.filter((token, index) => {
    if (values.has(index)) return true;
    if (token === "--") ended = true;
    const value = ended ? undefined : cliTimingFlagValue(token);
    if (value === undefined) return true;
    enabled = value;
    return false;
  });
  return { arguments: remaining, enabled };
};

/** Command tokens and output-flag values as Incur's builtin pass assigns them. */
export interface IncurBuiltinArgumentSplit {
  /** Tokens left for command resolution and command option parsing. */
  readonly command: readonly string[];
  /** Valueless global flags extracted by Incur before command dispatch. */
  readonly flags: ReadonlySet<string>;
  /** Positions of nonempty values consumed by valued output flags. */
  readonly outputValues: readonly {
    readonly flag: string;
    readonly index: number;
  }[];
}

/**
 * Mirror Incur's builtin pass over normalized arguments without stopping at a
 * rejected value, so callers can still see every later token. Then mirror the
 * boolean timing global pass over the remaining tokens; no config is registered.
 */
export const splitIncurBuiltinArguments = (
  arguments_: readonly string[],
): IncurBuiltinArgumentSplit => {
  const command: string[] = [];
  const flags = new Set<string>();
  const outputValues: { readonly flag: string; readonly index: number }[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    const next = arguments_[index + 1];
    if (
      (INCUR_BUILTIN_FLAGS.has(argument) && argument !== "--timings") ||
      // A following value belongs to a command-local `--version` option.
      (argument === "--version" && (next === undefined || next.startsWith("-")))
    ) {
      flags.add(argument);
      continue;
    }
    if (VALUED_OUTPUT_FLAGS.has(argument) && next) {
      outputValues.push({ flag: argument, index: index + 1 });
      index += 1;
      continue;
    }
    command.push(argument);
  }
  // Incur extracts builtin output values first, then parses globals until `--`.
  // A timing-shaped output value is data; a command option's value is still
  // subject to this global pass before the registration builtin consumes it.
  let globalsEnded = false;
  const remaining = command.filter((token) => {
    if (token === "--") globalsEnded = true;
    if (!globalsEnded && cliTimingFlagValue(token) !== undefined) {
      flags.add(token);
      return false;
    }
    return true;
  });
  return { command: remaining, flags, outputValues };
};

/**
 * Route the root update alias and split `--flag=value` output forms. Incur reads these
 * flags only in spaced form, so `--format=json` otherwise reaches the command
 * parser and fails as an unknown flag. Command options accept both forms.
 */
export const normalizeCliArguments = (
  arguments_: readonly string[],
): string[] => {
  const normalized: string[] = [];
  const updates = new Set<number>();
  let rootUpdate = true;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (VALUED_OUTPUT_FLAGS.has(argument) && arguments_[index + 1]) {
      // Incur consumes a nonempty spaced value before looking for more flags.
      // Its contents belong to that option, even when they look like a flag.
      normalized.push(argument, arguments_[index + 1]!);
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
  // Help/check/command/unknown tokens retain Incur's parsing and precedence.
  return rootUpdate && updates.size > 0
    ? ["update", ...normalized.filter((_, index) => !updates.has(index))]
    : normalized;
};

/** Keep REA-owned delimited formats out of Incur's narrower formatter surface. */
export const adaptCliOutputArgumentsForIncur = (
  arguments_: readonly string[],
): string[] => {
  const adapted: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    const value = arguments_[index + 1];
    if (VALUED_OUTPUT_FLAGS.has(argument)) {
      if (argument === "--columns") {
        if (value !== undefined) index += 1;
        continue;
      }
      if (argument === "--format" && (value === "csv" || value === "tsv")) {
        adapted.push("--format", "json");
        index += 1;
        continue;
      }
      adapted.push(argument);
      if (value) {
        adapted.push(value);
        index += 1;
      }
      continue;
    }
    adapted.push(argument);
  }
  return adapted;
};

/**
 * Detect a project-scoped Amp registration before Incur dispatches it.
 * Incur's `mcp add` parses `--no-global` into `global: false` and honors it
 * for its package-runner agents, but its Amp writer always writes the global
 * settings file and ignores the flag. The scan mirrors Incur's parsing: only
 * the spaced `--agent` form counts, `--command`/`-c` consumes its value, and
 * Amp registers by default when no agent is given, so a bare project-scoped
 * request would still write global Amp settings. Discovery requests are not
 * registrations: the same discovery flags `mcp add` itself exempts pass
 * through instead of tripping the guard.
 */
// ponytail: reject instead of implementing project-scoped Amp registration.
// Ceiling: `mcp add --no-global` with Amp fails until Incur supports Amp
// project scope. Upgrade: drop this guard and its rea.mjs wiring once the
// dependency writes project Amp settings, and cover that path instead.
/** Discovery flags `mcp add` answers instead of registering. */
const MCP_ADD_DISCOVERY_FLAGS: ReadonlySet<string> = new Set([
  "--help",
  "-h",
  "--llms",
  "--llms-full",
  "--version",
  "--schema",
]);

export const isProjectScopedAmpRegistration = (
  arguments_: readonly string[],
): boolean => {
  const { command, flags } = splitIncurBuiltinArguments(arguments_);
  if (command[0] !== "mcp" || command[1] !== "add") return false;
  if ([...flags].some((flag) => MCP_ADD_DISCOVERY_FLAGS.has(flag)))
    return false;
  const rest = command.slice(2);
  if (!rest.includes("--no-global")) return false;
  const agents: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if ((token === "--command" || token === "-c") && index + 1 < rest.length)
      index += 1;
    else if (token === "--agent" && index + 1 < rest.length) {
      agents.push(rest[index + 1]!);
      index += 1;
    }
  }
  return agents.length === 0 || agents.includes("amp");
};

/** Select production doctor using the same normalized builtin argument owner as CLI dispatch. */
export const productionMcpDoctorArguments = (
  arguments_: readonly string[],
): readonly string[] | undefined => {
  const normalized = normalizeCliArguments(arguments_);
  const split = splitIncurBuiltinArguments(normalized);
  if (split.command[0] !== "mcp" || split.command[1] !== "doctor")
    return undefined;
  const values = new Set(split.outputValues.map(({ index }) => index));
  const mcp = normalized.findIndex(
    (token, index) => token === "mcp" && !values.has(index),
  );
  const doctor = normalized.findIndex(
    (token, index) => index > mcp && token === "doctor" && !values.has(index),
  );
  return normalized.filter((_, index) => index !== mcp && index !== doctor);
};

/** Incur accepts the schema key and its kebab-case spelling. */
const FLAGS = ["--sensitive-value", "--sensitiveValue"] as const;

/**
 * Read declarations from the tokens Incur leaves for command parsing. Incur
 * rejects a malformed token before it reaches later declarations, so this scan
 * is independent of parse success. A token following a declaration flag counts
 * as declared even where the command parser would bind it to another option.
 */
export const declaredSensitiveValues = (
  command: IncurBuiltinArgumentSplit["command"],
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
