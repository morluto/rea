import type { Client } from "@modelcontextprotocol/client";

import { TOOL_CONTRACTS } from "../../src/contracts/toolContracts.js";
import { AGENT_BUDGET_OPERATIONS } from "../../src/domain/agentBudgetOperations.js";
import { createCli } from "../../src/cli.js";
import { cliCommands } from "../../src/cli/commandRegistry.js";
import { COMPLETE_DETAIL } from "./completeDetail.js";

/**
 * Test-harness delivery policy. Production omitted `detail` is budgeted:
 * complete Evidence when it fits the agent result budget, a retained summary
 * otherwise. Most tests read complete Evidence, so the shared transport
 * helpers request it by default. Tests whose subject is delivery itself pass
 * `"budgeted"` to send calls exactly as written.
 */
export type TestDelivery = "completeEvidenceByDefault" | "budgeted";

const contracts = new Map(
  TOOL_CONTRACTS.map((contract) => [contract.name, contract] as const),
);

/**
 * Each budgeted operation must resolve to a tool contract; otherwise the
 * default could not know what it changes, so the harness fails loudly at
 * load instead of guessing. `src/contracts/analysisDetail.test.ts` proves the
 * list equals the contracts whose omitted `detail` is budgeted. Every other
 * tool, an REA contract or a forwarded upstream tool, is sent as written.
 */
const budgeted: ReadonlySet<string> = new Set(
  AGENT_BUDGET_OPERATIONS.map((name) => {
    if (!contracts.has(name))
      throw new Error(
        `completeEvidenceByDefault cannot resolve a tool contract for budgeted operation "${name}".`,
      );
    return name;
  }),
);
/**
 * CLI commands that accept `--detail`, read from the CLI's own registry. The
 * CLI budgets every Evidence-delivery command whose `--detail` is omitted,
 * and only those commands take `--detail`, so a contract's `cli` flag alone
 * cannot tell.
 */
let detailCommandSet: ReadonlySet<string> | undefined;
const detailCommandNames = (): ReadonlySet<string> =>
  (detailCommandSet ??= new Set(
    cliCommands(createCli({}))
      .filter(
        (entry) =>
          (entry.definition.options as { readonly shape?: object } | undefined)
            ?.shape !== undefined &&
          Object.hasOwn(
            (entry.definition.options as { readonly shape: object }).shape,
            "detail",
          ),
      )
      .map(({ name }) => name),
  ));

/**
 * The arguments one MCP call sends under the complete-Evidence default: a
 * budgeted tool called with neither `detail` nor `view` gets
 * `detail: "complete"`. Any other tool is sent as written.
 */
export const completeEvidenceArguments = (
  name: string,
  arguments_: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!budgeted.has(name)) return arguments_;
  const selected = arguments_ ?? {};
  return Object.hasOwn(selected, "detail") || Object.hasOwn(selected, "view")
    ? arguments_
    : { ...selected, detail: "complete" };
};

/**
 * The argv one CLI invocation runs under the complete-Evidence default: a
 * command that takes `--detail`, given neither `--detail` nor `--view`, gets
 * `--detail complete` after the command word. Other commands (doctor, mcp,
 * help, commands without Evidence delivery) run as written.
 */
export const completeEvidenceCliArguments = (
  arguments_: readonly string[],
): readonly string[] => {
  const [command, ...rest] = arguments_;
  if (command === undefined || !detailCommandNames().has(command))
    return arguments_;
  const selects = (flag: string) =>
    rest.some(
      (argument) => argument === flag || argument.startsWith(`${flag}=`),
    );
  return selects("--detail") || selects("--view")
    ? arguments_
    : [command, ...COMPLETE_DETAIL, ...rest];
};

const applied = new WeakSet<Client>();

/**
 * Apply the complete-Evidence default to every `callTool` on this client.
 * The shared MCP helpers call it once per client they create.
 */
export const applyCompleteEvidenceByDefault = (
  client: Client,
  delivery: TestDelivery = "completeEvidenceByDefault",
): Client => {
  if (delivery === "budgeted" || applied.has(client)) return client;
  applied.add(client);
  const callTool = client.callTool.bind(client);
  client.callTool = ((params, ...rest) => {
    const arguments_ = completeEvidenceArguments(params.name, params.arguments);
    return callTool(
      arguments_ === undefined ? params : { ...params, arguments: arguments_ },
      ...rest,
    );
  }) as Client["callTool"];
  return client;
};
