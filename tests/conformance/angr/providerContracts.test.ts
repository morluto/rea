import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createAngrTarget, RecordingAngrMcp } from "../../fixtures/angrMcp.js";
import { AngrSessionClient } from "../../../src/angr/AngrSessionClient.js";
import { readAngrConfiguration } from "../../../src/angr/AngrConfiguration.js";
import {
  ANGR_MUTATING_OPERATIONS,
  ANGR_OPERATIONS,
  angrCapabilities,
} from "../../../src/angr/AngrProviderCapabilities.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { ToolResultDelivery } from "../../../src/server/toolResult.js";

const delivery = new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const parametersFor = (
  operation: string,
): Readonly<Record<string, JsonValue>> => {
  switch (operation) {
    case "xrefs":
      return { address: "0x1000" };
    case "set_address_name":
      return { address: "0x1000", name: "entry" };
    case "set_addresses_names":
      return { names: { "0x1000": "entry", "0x3000": "greeting" } };
    case "set_comment":
      return { address: "0x1004", comment: "validated" };
    case "annotate_native_function":
      return { procedure: "main", name: "entry", comment: "entry point" };
    case "rename_native_variables":
      return {
        items: [{ procedure: "main", variable: "v0", new_name: "username" }],
      };
    case "set_native_variable_types":
      return { items: [{ procedure: "main", variable: "v0", type: "char *" }] };
    case "set_native_function_prototypes":
      return { items: [{ procedure: "main", return_type: "void" }] };
    case "inspect_native_decompilation_flavor":
      return {};
    case "set_native_decompilation_flavor":
      return { flavor: "rust" };
    default:
      if (operation.startsWith("search_")) return { pattern: "a.b" };
      if (operation.startsWith("list_")) return {};
      return { procedure: "main" };
  }
};

describe("angr caller-visible contracts", () => {
  it("advertises every operation without UI effects, marks edits as mutations, and derives process effects from the transport", () => {
    for (const mode of ["attached", "headless"] as const)
      for (const transport of ["stdio", "http"] as const)
        for (const capability of angrCapabilities(mode, transport)) {
          expect(capability.available).toBe(true);
          expect(capability.effects).toMatchObject({
            mutatesArtifact: ANGR_MUTATING_OPERATIONS.has(capability.operation),
            mayShowUi: false,
            launchesProcess: transport === "stdio",
            mayWriteFilesystem: transport === "stdio",
            mayAccessNetwork: transport === "http" || mode === "attached",
          });
        }
  });
  it.each(ANGR_OPERATIONS)(
    "serializes %s against its named advertised output contract",
    async (operation) => {
      const { root, target } = await createAngrTarget();
      roots.push(root);
      const configuration = readAngrConfiguration({
        pythonPath: process.execPath,
      });
      if (!configuration.ok) throw configuration.error;
      const client = new AngrSessionClient(
        configuration.value,
        target,
        new RecordingAngrMcp(target),
      );
      try {
        const parameters = parametersFor(operation);
        const execution = await client.execute(operation, parameters);
        if (!execution.ok) throw execution.error;
        const evidence = createEvidence(target, execution.value.provider, {
          operation,
          parameters,
          result: execution.value.result,
          rawResult: execution.value.rawResult,
          locations: execution.value.locations,
          limitations: execution.value.limitations,
        });
        const contract = toolContract(operation);
        const serialized = delivery.toEvidenceToolResult(
          evidence,
          contract,
          undefined,
        );
        expect(
          contract.outputSchema.safeParse(serialized.structuredContent).success,
        ).toBe(true);
        expect(serialized.content[0]).toEqual({
          type: "text",
          text: JSON.stringify(serialized.structuredContent),
        });
      } finally {
        await client.close();
      }
    },
  );
});
