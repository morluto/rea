/**
 * Verifier helpers that read complete Evidence from the compiled CLI or MCP
 * request it explicitly, so the shipped budgeted default stays the default.
 * A CLI command that takes `--detail`, given neither `--detail` nor `--view`,
 * gets `--detail complete` after the command word; the set of such commands
 * is read from the compiled CLI's own registry. An MCP tool whose omitted
 * detail is budgeted, called with neither `detail` nor `view`, gets
 * `detail: "complete"`; the set is the compiled AGENT_BUDGET_OPERATIONS.
 */
let detailCommands;
let budgetedOperations;

const loadDetailCommands = async () => {
  if (detailCommands !== undefined) return detailCommands;
  const [{ createCli }, { cliCommands }] = await Promise.all([
    import("../../dist/cli.js"),
    import("../../dist/cli/commandRegistry.js"),
  ]);
  detailCommands = new Set(
    cliCommands(createCli({}))
      .filter(
        (entry) =>
          entry.definition.options?.shape !== undefined &&
          Object.hasOwn(entry.definition.options.shape, "detail"),
      )
      .map(({ name }) => name),
  );
  return detailCommands;
};

/** The argv for one CLI invocation that reads complete Evidence. */
export const completeEvidenceCliArguments = async (arguments_) => {
  const [command, ...rest] = arguments_;
  if (command === undefined || !(await loadDetailCommands()).has(command))
    return arguments_;
  const selects = (flag) =>
    rest.some(
      (argument) => argument === flag || argument.startsWith(`${flag}=`),
    );
  return selects("--detail") || selects("--view")
    ? arguments_
    : [command, "--detail", "complete", ...rest];
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
  if (wrapped.has(client)) return client;
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
