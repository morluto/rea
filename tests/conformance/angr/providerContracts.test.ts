import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createAngrTarget, RecordingAngrMcp } from "../../fixtures/angrMcp.js";
import { AngrSessionClient } from "../../../src/angr/AngrSessionClient.js";
import { readAngrConfiguration } from "../../../src/angr/AngrConfiguration.js";
import {
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
  if (operation.startsWith("search_")) return { pattern: "a.b" };
  if (operation === "xrefs") return { address: "0x1000" };
  if (operation.startsWith("list_")) return {};
  return { procedure: "main" };
};

describe("angr caller-visible contracts", () => {
  it("advertises every operation without UI or mutation effects", () => {
    for (const mode of ["attached", "headless"] as const)
      for (const capability of angrCapabilities(mode)) {
        expect(capability.available).toBe(true);
        expect(capability.effects).toMatchObject({
          mutatesArtifact: false,
          mayShowUi: false,
          launchesProcess: mode === "headless",
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
