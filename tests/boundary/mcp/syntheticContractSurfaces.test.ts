import { cliCommand } from "../../../src/cli/commandRegistry.js";
import { createCommandCli } from "../../support/cli/commandCli.js";
import { expect } from "vitest";
import { z } from "zod";

import { buildCapabilityInventory } from "../../../src/application/CapabilityInventory.js";
import {
  CLI_COMMAND_NAMES,
  cliCommandNames,
} from "../../../src/contracts/catalog/catalogIdentity.js";
import { registerContractCommand } from "../../../src/cli/contractCommand.js";
import type { CliInstance } from "../../../src/cli/types.js";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import type { ToolContract } from "../../../src/contracts/toolContractTypes.js";
import {
  annotationsFromEffects,
  toolContractMetadata,
  toolEffects,
} from "../../../src/contracts/toolEffects.js";
import { evidenceResultOf } from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import { err } from "../../../src/domain/result.js";
import { silentLogger } from "../../../src/logger.js";
import {
  registerContractTools,
  type ContractToolBindings,
} from "../../../src/server/contractToolBindings.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

/**
 * A contract declared only here: its effects, availability and CLI command
 * come from this declaration, with no edit to any registry, table or list.
 */
const synthetic = {
  name: "inspect_synthetic_fixture",
  availability: "standalone",
  cli: true,
  ...toolContractMetadata(
    "inspect_synthetic_fixture",
    toolEffects({ mutatesSession: true, launchesProcess: true }),
  ),
  // A provider kind is unavailable without the provider; only the
  // `availability: "standalone"` declaration makes it available below.
  kind: "android-provider",
  description: "Inspect one synthetic fixture path.",
  inputSchema: z.strictObject({ path: z.string() }),
  outputSchema: evidenceResultOf(z.object({})),
  examples: [],
} as const satisfies ToolContract;

const refusal = (input: unknown) =>
  err(
    new AnalysisInputError(synthetic.name, undefined, [
      {
        path: ["path"],
        reason: "invalid_value",
        message: `fixture refusal of ${JSON.stringify(input)}`,
      },
    ]),
  );

mcpTest(
  "carries a contract declared in a test through the CLI inventory, MCP tools/list and the capability inventory, and runs it",
  async ({ mcp }) => {
    const contracts = [...TOOL_CONTRACTS, synthetic];

    // CLI command inventory: derived from the declaration's `cli: true`.
    expect(CLI_COMMAND_NAMES).not.toContain("inspect-synthetic-fixture");
    expect(cliCommandNames(contracts)).toContain("inspect-synthetic-fixture");

    // CLI: the contract's own command runs its handler with the admitted input.
    const cli = createCommandCli();
    const cliReceived: unknown[] = [];
    registerContractCommand(
      cli as unknown as CliInstance,
      silentLogger,
      synthetic,
      { description: "Synthetic fixture", positionals: ["path"] },
      async (input) => {
        cliReceived.push(input);
        return {};
      },
    );
    const command = cliCommand(cli, "inspect-synthetic-fixture")?.definition;
    if (command === undefined)
      throw new Error("inspect-synthetic-fixture is not registered");
    const parse = (key: "args" | "options", value: unknown) =>
      (Reflect.get(command, key) as { parse(v: unknown): unknown }).parse(
        value,
      );
    await (Reflect.get(command, "run") as (value: unknown) => Promise<unknown>)(
      { args: parse("args", { path: "fixture.bin" }), options: {} },
    );
    expect(cliReceived).toEqual([{ path: "fixture.bin" }]);

    // MCP: the binding loop lists and dispatches the contract from the
    // registry passed to it.
    const mcpReceived: unknown[] = [];
    const server = new EvidenceMcpServer(
      { name: "synthetic-contract", version: "1" },
      {},
      undefined,
      createToolResultDelivery(undefined),
    );
    registerContractTools(
      server,
      {
        inspect_synthetic_fixture: {
          admission: "sdk",
          run: (input: unknown) => {
            mcpReceived.push(input);
            return Promise.resolve(refusal(input));
          },
        },
      } as ContractToolBindings,
      { logger: silentLogger },
      contracts,
    );
    const client = await mcp.connect(server);
    expect((await client.listTools()).tools).toEqual([
      expect.objectContaining({
        name: "inspect_synthetic_fixture",
        annotations: expect.objectContaining(synthetic.annotations),
      }),
    ]);
    const reply = await client.callTool({
      name: "inspect_synthetic_fixture",
      arguments: { path: "/fixture.bin" },
    });
    expect(parseMcpToolError(reply)).toMatchObject({
      error: {
        code: "invalid_request",
        details: { operation: "inspect_synthetic_fixture" },
      },
    });
    expect(mcpReceived).toEqual([{ path: "/fixture.bin" }]);

    // Capability inventory: availability and session effects come from the
    // declaration.
    const sessionAnnotations = annotationsFromEffects(synthetic.sessionEffects);
    const inventory = buildCapabilityInventory(
      { open: false, capabilities: [] },
      { processCaptureEnabled: false },
      () => true,
      contracts,
    );
    expect(inventory.find(({ name }) => name === synthetic.name)).toMatchObject(
      {
        name: synthetic.name,
        surface: "android-provider",
        available: true,
        annotations: {
          read_only: sessionAnnotations.readOnlyHint,
          destructive: sessionAnnotations.destructiveHint,
          idempotent: sessionAnnotations.idempotentHint,
          open_world: sessionAnnotations.openWorldHint,
        },
      },
    );
    const { availability: _declared, ...undeclared } = synthetic;
    expect(
      buildCapabilityInventory(
        { open: false, capabilities: [] },
        { processCaptureEnabled: false },
        () => true,
        [...TOOL_CONTRACTS, undeclared],
      ).find(({ name }) => name === synthetic.name),
    ).toMatchObject({ available: false, reason: "provider_missing" });
  },
);
