import { IDA_COMPATIBILITY_PROFILES } from "../../../src/ida/IdaConfiguration.js";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createIdaTarget, RecordingIdaMcp } from "../../fixtures/idaMcp.js";
import { IdaSessionClient } from "../../../src/ida/IdaSessionClient.js";
import { idaCapabilities } from "../../../src/ida/IdaProviderCapabilities.js";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";

const delivery = createToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
/** Native GUI decompilation changes the active view; headless tools never do. */
const guiNavigatingTool = (mode: "attached" | "headless", name: string) =>
  mode === "attached" && name === "decompile";

const parametersFor = (
  operation: string,
): Readonly<Record<string, JsonValue>> => {
  if (operation.startsWith("search_")) return { pattern: "a.b" };
  if (operation === "xrefs" || operation === "resolve_containing_procedure")
    return { address: "0x1000" };
  if (operation.startsWith("list_")) return {};
  return { procedure: "main" };
};

describe.each(["attached", "headless"] as const)(
  "IDA %s caller-visible contracts",
  (mode) => {
    const profile =
      IDA_COMPATIBILITY_PROFILES[mode === "attached" ? "native" : "modern"];
    it.each(idaCapabilities(profile, true))(
      "checks the advertised $operation output contract and UI effect",
      async ({ operation, available, effects }) => {
        const { root, target } = await createIdaTarget();
        roots.push(root);
        const producer = new RecordingIdaMcp(target, mode);
        const client = new IdaSessionClient(
          {
            command: "fixture",
            args: [],
            env: {},
            mode,
            protocol: profile.protocol,
            workspaceRoot: root,
            timeoutMs: 1000,
          },
          target,
          producer,
        );
        try {
          const parameters = parametersFor(operation);
          const execution = await client.execute(operation, parameters);
          expect(effects.mayShowUi).toBe(
            producer.calls.some(({ name }) => guiNavigatingTool(mode, name)),
          );
          if (!available) {
            expect(execution).toMatchObject({
              ok: false,
              error: { _tag: "AnalysisCapabilityUnavailableError", operation },
            });
            return;
          }
          if (!execution.ok) throw execution.error;
          if (operation === "list_documents")
            expect(execution.value.result).toEqual([target.path]);
          const evidence = createEvidence(target, execution.value.provider, {
            operation,
            parameters,
            result: execution.value.result,
            rawResult: execution.value.rawResult,
            locations: execution.value.locations,
            limitations: execution.value.limitations,
          });
          const contract = TOOL_CONTRACTS.find(
            ({ name }) => name === operation,
          );
          if (contract === undefined)
            throw new Error(`Missing tool contract for ${operation}`);
          const serialized = delivery.toEvidenceToolResult(
            evidence,
            contract,
            undefined,
          );
          expect(
            contract.outputSchema.safeParse(serialized.structuredContent)
              .success,
          ).toBe(true);
          expect(serialized.content[0]).toEqual({
            type: "text",
            text: JSON.stringify(serialized.structuredContent),
          });
        } finally {
          expect((await client.close()).ok).toBe(true);
        }
      },
    );
  },
);
