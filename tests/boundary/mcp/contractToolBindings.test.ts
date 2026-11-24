import { expect, expectTypeOf, vi } from "vitest";
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
  "reports a failed optional provider before admission, execution or recording",
  async ({ mcp }) => {
    const server = evidenceServer();
    const unavailable = async () => {
      throw new Error("A failed provider must not do this work");
    };
    const withAdmittedAnalysis = vi.fn(unavailable);
    const run = vi.fn(unavailable);
    const recordEvidence = vi.fn(() => ok("added" as const));
    registerContractTools(
      server,
      {
        inspect_web_page: {
          admission: "sdk",
          unavailable: {
            providerId: "browser",
            reason: "controlled provider load failure",
          },
          run,
        },
      },
      { logger: silentLogger, withAdmittedAnalysis, recordEvidence },
    );
    const client = await mcp.connect(server);
    const result = await client.callTool({
      name: "inspect_web_page",
      arguments: {
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "fixture",
      },
    });
    expect(parseMcpToolError(result).error).toMatchObject({
      code: "capability_unavailable",
      details: { operation: "inspect_web_page" },
    });
    expect(JSON.stringify(result.content)).toContain(
      "controlled provider load failure",
    );
    expect(result._meta).toEqual({
      provenance: { untrusted_content: true, source: "analysis_target" },
    });
    expect(withAdmittedAnalysis).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(recordEvidence).not.toHaveBeenCalled();
  },
);

mcpTest(
  "preserves partial nested limits through the application-admitted source-map binding",
  async ({ mcp }) => {
    const received = vi.fn(async (_input: unknown) =>
      err(new AnalysisInputError("trace_web_source_location")),
    );
    const server = evidenceServer();
    registerContractTools(
      server,
      {
        trace_web_source_location: {
          admission: "application",
          summary: received,
        },
      },
      { logger: silentLogger },
    );
    const client = await mcp.connect(server);
    const request = {
      manifest_path: "/analysis/scripts/manifest.json",
      script_index: 0,
      source_map: {
        path: "/analysis/app.js.map",
        url: "https://example.test/app.js.map",
      },
      generated_position: { line: 1, column: 25 },
      source_map_limits: { decoded_records: 12 },
    };
    const reply = await client.callTool({
      name: "trace_web_source_location",
      arguments: { ...request, detail: "complete" },
    });
    expect(reply.isError).toBe(true);
    expect(received).toHaveBeenCalledExactlyOnceWith(
      request,
      expect.any(Object),
    );
  },
);

mcpTest(
  "keeps SDK defaults and caller selections at their named retained-summary boundaries",
  async ({ mcp }) => {
    const inspectEntropy = vi.fn(async (_input: unknown) =>
      err(new AnalysisInputError("inspect_byte_entropy")),
    );
    const inspectDependencies = vi.fn(async (_input: unknown) =>
      err(new AnalysisInputError("inspect_elf_dependencies")),
    );
    const server = evidenceServer();
    registerContractTools(
      server,
      {
        inspect_byte_entropy: { admission: "sdk", summary: inspectEntropy },
        inspect_elf_dependencies: {
          admission: "application",
          summary: inspectDependencies,
        },
      },
      { logger: silentLogger },
    );
    const client = await mcp.connect(server);
    expect(
      (await client.listTools()).tools.map(({ name }) => name).sort(),
    ).toEqual(["inspect_byte_entropy", "inspect_elf_dependencies"]);
    const path = "/fixture";
    const call = async (name: string, input: Record<string, unknown>) => {
      const reply = await client.callTool({
        name,
        arguments: { ...input, path, detail: "complete" },
      });
      expect(reply.isError).toBe(true);
    };
    await call("inspect_byte_entropy", {});
    await call("inspect_byte_entropy", { block_size: 256 });
    await call("inspect_elf_dependencies", {});
    await call("inspect_elf_dependencies", { max_needed: 1024 });

    expect(inspectEntropy.mock.calls.map(([input]) => input)).toEqual([
      { path, block_size: 4096, offset: 0 },
      { path, block_size: 256, offset: 0 },
    ]);
    expect(inspectDependencies.mock.calls.map(([input]) => input)).toEqual([
      { path },
      { path, max_needed: 1024 },
    ]);

    // The named binding type must accept a summary only for a detail-aware
    // contract and must make handler variants mutually exclusive.
    type Operation = () => Promise<never>;
    type Devicetree = NonNullable<ContractToolBindings["inspect_devicetree"]>;
    type PeImports = NonNullable<ContractToolBindings["inspect_pe_imports"]>;
    expectTypeOf<{
      admission: "application";
      summary: Operation;
    }>().toExtend<Devicetree>();
    expectTypeOf<{
      admission: "application";
      run: Operation;
      summary: Operation;
    }>().not.toExtend<Devicetree>();
    expectTypeOf<{
      admission: "sdk";
      summary: Operation;
    }>().not.toExtend<PeImports>();
    expectTypeOf<{
      admission: "sdk";
      session: never;
      derive: () => never;
      run: Operation;
    }>().not.toExtend<PeImports>();
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
    expectTypeOf<{
      admission: "sdk";
      provider: { operation: "xrefs"; activeTarget: undefined };
    }>().not.toExtend<
      NonNullable<ContractToolBindings["inspect_pe_imports"]>
    >();
    expect(() =>
      registerContractTools(evidenceServer(), mismatched, {
        logger: silentLogger,
        withAdmittedAnalysis: async () => {
          throw new Error("not called");
        },
      }),
    ).toThrow("MCP tool xrefs binds provider operation extract_artifact");
  },
);
