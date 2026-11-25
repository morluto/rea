import { resolve } from "node:path";
import type { Client } from "@modelcontextprotocol/client";

import { TOOL_CONTRACTS } from "../../src/contracts/toolContracts.js";
import { AGENT_BUDGET_OPERATIONS } from "../../src/domain/agentBudgetOperations.js";
import { createCli } from "../../src/cli.js";
import { parseCliArgv } from "../../src/cli/argvParser.js";
import { cliCommands } from "../../src/cli/commandRegistry.js";
import { isJavaScriptApplicationPath } from "../../src/cli/coreBinaryCommands.js";
import { parseCliGlobalArguments } from "../../src/cliBuiltinArguments.js";
import { COMPLETE_DETAIL } from "./completeDetail.js";

/**
 * Test-harness delivery policy. Production omitted `detail` is budgeted:
 * complete Evidence when it fits the agent result budget, a retained summary
 * otherwise. Most tests read complete Evidence, so the shared transport
 * helpers request it by default. Tests whose subject is delivery itself pass
 * `"budgeted"` to send calls exactly as written.
 */
export type TestDelivery = "completeEvidenceByDefault" | "budgeted";

/**
 * The server environment for a test's delivery choice. The test environment
 * seeds the largest agent result budget so spawned processes deliver complete
 * Evidence; a "budgeted" test removes that seed and gets the shipped default.
 */
export const testDeliveryEnvironment = (
  environment: NodeJS.ProcessEnv,
  delivery: TestDelivery | undefined,
): NodeJS.ProcessEnv => {
  if (delivery !== "budgeted") return environment;
  const { REA_AGENT_RESULT_BUDGET_BYTES: _seed, ...shipped } = environment;
  return shipped;
};

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

interface CliDetailMetadata {
  readonly detailCommands: ReadonlySet<string>;
  readonly analyzeEntry: ReturnType<typeof cliCommands>[number] | undefined;
  readonly jsOptionKeys: ReadonlySet<string>;
}

/**
 * CLI commands whose `--detail` accepts `"complete"`, read from the CLI's own
 * registry. Commands whose `--detail` uses another enum (such as
 * `import-reference-source` with `"full" | "summary"`) are excluded.
 */
let cachedCliMetadata: CliDetailMetadata | undefined;
const cliDetailMetadata = (): CliDetailMetadata => {
  if (cachedCliMetadata !== undefined) return cachedCliMetadata;
  const commands = new Map(
    cliCommands(createCli({})).map((entry) => [entry.name, entry] as const),
  );
  const detailCommands = new Set(
    [...commands.values()]
      .filter((entry) => {
        const shape = (
          entry.definition.options as
            | {
                readonly shape?: Readonly<
                  Record<
                    string,
                    {
                      safeParse?: (v: unknown) => { readonly success: boolean };
                    }
                  >
                >;
              }
            | undefined
        )?.shape;
        const detail = shape?.detail;
        return (
          detail !== undefined &&
          typeof detail.safeParse === "function" &&
          detail.safeParse("complete").success
        );
      })
      .map(({ name }) => name),
  );
  const jsShape = (
    commands.get("analyze-javascript-application")?.definition.options as
      | { readonly shape?: object }
      | undefined
  )?.shape;
  cachedCliMetadata = {
    detailCommands,
    analyzeEntry: commands.get("analyze"),
    jsOptionKeys: new Set(jsShape === undefined ? [] : Object.keys(jsShape)),
  };
  return cachedCliMetadata;
};

/** Whether an `analyze` invocation selects the JavaScript route (which takes `--detail`). */
const selectsAnalyzeJavaScriptRoute = async (
  metadata: CliDetailMetadata,
  commandArgs: readonly string[],
  cwd: string | undefined,
): Promise<boolean> => {
  if (metadata.analyzeEntry === undefined) return false;
  const parsed = parseCliArgv(commandArgs, metadata.analyzeEntry.definition);
  if (!parsed.ok) return false;
  const suppliedOptions = Object.entries(parsed.value.options)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  if (!suppliedOptions.every((key) => metadata.jsOptionKeys.has(key)))
    return false;
  const target = parsed.value.args.path;
  if (typeof target !== "string" || target.length === 0) return false;
  return isJavaScriptApplicationPath(resolve(cwd ?? process.cwd(), target));
};

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
 * command whose `--detail` accepts `"complete"`, given neither `--detail` nor
 * `--view` (and selecting a route that accepts `--detail` when routed), gets
 * `--detail complete` after the command word. Other commands run as written.
 */
export const completeEvidenceCliArguments = async (
  arguments_: readonly string[],
  cwd?: string,
): Promise<readonly string[]> => {
  const [command, ...rest] = arguments_;
  const metadata = cliDetailMetadata();
  if (command === undefined || !metadata.detailCommands.has(command))
    return arguments_;
  const global = parseCliGlobalArguments(arguments_);
  if (
    global.flags.has("--help") ||
    global.flags.has("-h") ||
    global.flags.has("--schema")
  )
    return arguments_;
  const selects = (flag: string) =>
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
  return [command, ...COMPLETE_DETAIL, ...rest];
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
