import { resolve } from "node:path";

/**
 * Verifier helpers that read complete Evidence from the compiled CLI or MCP
 * request it explicitly, so the shipped budgeted default stays the default.
 * A CLI command whose `--detail` accepts `"complete"`, given neither `--detail`
 * nor `--view` (and selecting a route that accepts `--detail` when routed,
 * such as `analyze` on a JavaScript target), gets `--detail complete` after
 * the command word. An MCP tool whose omitted detail is budgeted, called with
 * neither `detail` nor `view`, gets `detail: "complete"`.
 */
let cliMetadata;
let budgetedOperations;

const loadCliMetadata = async () => {
  if (cliMetadata !== undefined) return cliMetadata;
  const [
    { createCli },
    { cliCommands },
    { parseCliGlobalArguments },
    { parseCliArgv },
    { isJavaScriptApplicationPath },
  ] = await Promise.all([
    import("../../dist/cli.js"),
    import("../../dist/cli/commandRegistry.js"),
    import("../../dist/cliBuiltinArguments.js"),
    import("../../dist/cli/argvParser.js"),
    import("../../dist/cli/coreBinaryCommands.js"),
  ]);
  const commands = new Map(
    cliCommands(createCli({})).map((entry) => [entry.name, entry]),
  );
  const detailCommands = new Set(
    [...commands.values()]
      .filter((entry) => {
        const detail = entry.definition.options?.shape?.detail;
        return detail !== undefined && detail.safeParse("complete").success;
      })
      .map(({ name }) => name),
  );
  const analyzeEntry = commands.get("analyze");
  const jsOptionKeys = new Set(
    Object.keys(
      commands.get("analyze-javascript-application")?.definition.options
        ?.shape ?? {},
    ),
  );
  cliMetadata = {
    detailCommands,
    analyzeEntry,
    jsOptionKeys,
    parseCliGlobalArguments,
    parseCliArgv,
    isJavaScriptApplicationPath,
  };
  return cliMetadata;
};

/** Whether an `analyze` invocation selects the JavaScript route (which takes `--detail`). */
const selectsAnalyzeJavaScriptRoute = async (metadata, commandArgs, cwd) => {
  if (metadata.analyzeEntry === undefined) return false;
  const parsed = metadata.parseCliArgv(
    commandArgs,
    metadata.analyzeEntry.definition,
  );
  if (!parsed.ok) return false;
  const suppliedOptions = Object.entries(parsed.value.options)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  if (!suppliedOptions.every((key) => metadata.jsOptionKeys.has(key)))
    return false;
  const target = parsed.value.args.path;
  if (typeof target !== "string" || target.length === 0) return false;
  return metadata.isJavaScriptApplicationPath(
    resolve(cwd ?? process.cwd(), target),
  );
};

/** The argv for one CLI invocation that reads complete Evidence. */
export const completeEvidenceCliArguments = async (arguments_, cwd) => {
  const [command, ...rest] = arguments_;
  if (
    typeof command !== "string" ||
    !rest.every((argument) => typeof argument === "string")
  )
    return arguments_;
  const metadata = await loadCliMetadata();
  if (!metadata.detailCommands.has(command)) return arguments_;
  const global = metadata.parseCliGlobalArguments(arguments_);
  if (
    global.flags.has("--help") ||
    global.flags.has("-h") ||
    global.flags.has("--schema")
  )
    return arguments_;
  const selects = (flag) =>
    rest.some(
      (argument) => argument === flag || argument.startsWith(`${flag}=`),
    );
  if (selects("--detail") || selects("--view")) return arguments_;
  if (
    command === "analyze" &&
    !(await selectsAnalyzeJavaScriptRoute(
      metadata,
      global.command.slice(1),
      cwd,
    ))
  )
    return arguments_;
  return [command, "--detail", "complete", ...rest];
};

/** The arguments for one MCP tool call that reads complete Evidence. */
export const completeEvidenceToolArguments = async (name, arguments_) => {
  budgetedOperations ??= new Set(
    (await import("../../dist/domain/agentBudgetOperations.js"))
      .AGENT_BUDGET_OPERATIONS,
  );
  if (!budgetedOperations.has(name)) return arguments_;
  const selected = arguments_ ?? {};
  return Object.hasOwn(selected, "detail") || Object.hasOwn(selected, "view")
    ? arguments_
    : { ...selected, detail: "complete" };
};

const wrapped = new WeakSet();

/**
 * Apply the complete-Evidence request to every `callTool` on a verifier's
 * SDK client. Calls to tools that are not budgeted, including other servers'
 * tools, are sent as written.
 */
export const completeEvidenceClient = (client) => {
  // A client without callTool, such as a cleanup test's connection double,
  // has no tool call to request complete Evidence for.
  if (wrapped.has(client) || typeof client.callTool !== "function")
    return client;
  wrapped.add(client);
  const callTool = client.callTool.bind(client);
  client.callTool = async (params, ...rest) => {
    const arguments_ = await completeEvidenceToolArguments(
      params.name,
      params.arguments,
    );
    return callTool(
      arguments_ === undefined ? params : { ...params, arguments: arguments_ },
      ...rest,
    );
  };
  return client;
};
