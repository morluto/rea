import { expect } from "vitest";
import {
  TOOL_CONTRACTS,
  toolContract,
} from "../../../src/contracts/toolContracts.js";
import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import { err, ok } from "../../../src/domain/result.js";
import { silentLogger } from "../../../src/logger.js";
import {
  registerContractTools,
  type ContractToolBindings,
} from "../../../src/server/contractToolBindings.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

const evidenceServer = () =>
  new EvidenceMcpServer(
    { name: "contract-tool-bindings", version: "1" },
    {},
    undefined,
    createToolResultDelivery(undefined),
  );

mcpTest(
  "registers a contract added to the registry from its binding alone",
  async ({ mcp }) => {
    const synthetic = {
      ...toolContract("inspect_pe_imports"),
      name: "inspect_synthetic_fixture",
      title: "Inspect synthetic fixture",
    };
    const received: unknown[] = [];
    const server = evidenceServer();
    registerContractTools(
      server,
      {
        inspect_synthetic_fixture: {
          admission: "application",
          run: (input: unknown) => {
            received.push(input);
            return Promise.resolve(
              err(
                new AnalysisInputError("inspect_synthetic_fixture", undefined, [
                  {
                    path: ["path"],
                    reason: "invalid_value",
                    message: "fixture refusal",
                  },
                ]),
              ),
            );
          },
        },
      } as ContractToolBindings,
      { logger: silentLogger },
      [...TOOL_CONTRACTS, synthetic],
    );
    const client = await mcp.connect(server);

    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
      "inspect_synthetic_fixture",
    ]);
    const reply = await client.callTool({
      name: "inspect_synthetic_fixture",
      arguments: { path: "/fixture" },
    });
    expect(parseMcpToolError(reply)).toMatchObject({
      error: {
        code: "invalid_request",
        details: { operation: "inspect_synthetic_fixture" },
      },
    });
    expect(received).toEqual([{ path: "/fixture" }]);
  },
);

mcpTest(
  "refuses at startup a binding that names no registered contract",
  () => {
    expect(() =>
      registerContractTools(
        evidenceServer(),
        {
          inspect_retired_fixture: {
            admission: "sdk",
            run: () => Promise.reject(new Error("must not run")),
          },
        } as ContractToolBindings,
        { logger: silentLogger },
      ),
    ).toThrow(/inspect_retired_fixture/);
  },
);

mcpTest(
  "runs a value binding under analysis admission only when it declares it",
  async ({ mcp }) => {
    const ran: string[] = [];
    const admitted: string[] = [];
    const refusal = (operation: string) =>
      new AnalysisInputError(operation, undefined, [
        { path: [], reason: "invalid_value", message: `${operation} refusal` },
      ]);
    const value = (operation: string) => () => {
      ran.push(operation);
      return Promise.resolve(err(refusal(operation)));
    };
    const server = evidenceServer();
    registerContractTools(
      server,
      {
        evaluate_reconstruction_coverage: {
          admission: "application",
          admitted: true,
          value: value("evaluate_reconstruction_coverage"),
        },
        search_guidance: {
          admission: "application",
          value: value("search_guidance"),
        },
      },
      {
        logger: silentLogger,
        withAdmittedAnalysis: async (operationName) => {
          admitted.push(operationName);
          return err(refusal("admission"));
        },
      },
    );
    const client = await mcp.connect(server);
    const call = async (name: string) =>
      parseMcpToolError(await client.callTool({ name, arguments: {} }));

    expect(await call("evaluate_reconstruction_coverage")).toMatchObject({
      error: { details: { operation: "admission" } },
    });
    expect(await call("search_guidance")).toMatchObject({
      error: { details: { operation: "search_guidance" } },
    });
    expect(admitted).toEqual(["evaluate_reconstruction_coverage"]);
    expect(ran).toEqual(["search_guidance"]);
  },
);

mcpTest(
  "reads the analysis a query's admission grants, and refuses a query on a server that admits none",
  async ({ mcp }) => {
    const analysis = { kind: "fixture-analysis" } as never;
    const received: unknown[] = [];
    const bindings: ContractToolBindings = {
      get_navigation_context: {
        admission: "sdk",
        query: async (_input, granted) => {
          received.push(granted);
          return ok({
            document: "fixture",
            address: "0x1000",
            procedure: null,
          });
        },
      },
    };
    expect(() =>
      registerContractTools(evidenceServer(), bindings, {
        logger: silentLogger,
      }),
    ).toThrow(/get_navigation_context/);

    const admitted: string[] = [];
    const server = evidenceServer();
    registerContractTools(server, bindings, {
      logger: silentLogger,
      withAdmittedAnalysis: async (operationName, _signal, operation) => {
        admitted.push(operationName);
        return ok(await operation(analysis));
      },
    });
    const client = await mcp.connect(server);
    const reply = await client.callTool({
      name: "get_navigation_context",
      arguments: {},
    });
    expect(reply.isError ?? false, JSON.stringify(reply)).toBe(false);
    expect(reply.structuredContent).toEqual({
      result: { document: "fixture", address: "0x1000", procedure: null },
    });
    expect(admitted).toEqual(["get_navigation_context"]);
    expect(received).toEqual([analysis]);
  },
);

type Operation = () => Promise<never>;
type DevicetreeBinding = NonNullable<
  ContractToolBindings["inspect_devicetree"]
>;
type PeImportsBinding = NonNullable<ContractToolBindings["inspect_pe_imports"]>;

mcpTest(
  "binds exactly one handler, and a retained summary only to a contract that selects detail",
  () => {
    // Type-level checks hold under every supported TypeScript checker,
    // whichever line it reports an excess-property error on.
    const summaryAccepted: {
      readonly admission: "application";
      readonly summary: Operation;
    } extends DevicetreeBinding
      ? true
      : false = true;
    const bothRefused: {
      readonly admission: "application";
      readonly run: Operation;
      readonly summary: Operation;
    } extends DevicetreeBinding
      ? false
      : true = true;
    const summaryWithoutDetailRefused: {
      readonly admission: "sdk";
      readonly summary: Operation;
    } extends PeImportsBinding
      ? false
      : true = true;
    // A session-derived workflow is its own handler kind, never combined
    // with a run or value handler.
    const deriveWithRunRefused: {
      readonly admission: "sdk";
      readonly session: never;
      readonly derive: () => never;
      readonly run: Operation;
    } extends PeImportsBinding
      ? false
      : true = true;
    expect([
      summaryAccepted,
      bothRefused,
      summaryWithoutDetailRefused,
      deriveWithRunRefused,
    ]).toEqual([true, true, true, true]);
  },
);

mcpTest(
  "binds a provider operation only to the contract of the same name",
  () => {
    const mismatched: ContractToolBindings = {
      xrefs: {
        admission: "sdk",
        // @ts-expect-error A provider binding runs only its own operation.
        provider: { operation: "extract_artifact", activeTarget: undefined },
      },
    };
    const notProvider: ContractToolBindings = {
      inspect_pe_imports: {
        admission: "sdk",
        // @ts-expect-error A tool that is no provider operation binds no provider.
        provider: { operation: "xrefs", activeTarget: undefined },
      },
    };
    expect(() =>
      registerContractTools(evidenceServer(), mismatched, {
        logger: silentLogger,
        withAdmittedAnalysis: async () => {
          throw new Error("not called");
        },
      }),
    ).toThrow("MCP tool xrefs binds provider operation extract_artifact");
    expect(notProvider).toBeDefined();
  },
);
