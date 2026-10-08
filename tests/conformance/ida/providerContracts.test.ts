import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createIdaTarget, RecordingIdaMcp } from "../../fixtures/idaMcp.js";
import { IdaSessionClient } from "../../../src/ida/IdaSessionClient.js";
import { IDA_OPERATIONS } from "../../../src/ida/IdaProviderCapabilities.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { privateRuntimeRootCapability } from "../../../src/process/PrivateRuntimeRoot.js";
import { toCallToolResult } from "../../../src/server/toolResult.js";

// Headless sessions allocate a private workspace; on win32 that requires the
// packaged native addon, which source checkouts do not carry.
const runtimeRootAvailable = privateRuntimeRootCapability().available;

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
  if (operation.startsWith("list_")) return { document: null };
  return { procedure: "main" };
};

describe.each(
  (["attached", "headless"] as const).filter(
    (mode) => mode !== "headless" || runtimeRootAvailable,
  ),
)("IDA %s caller-visible contracts", (mode) => {
  it.each(IDA_OPERATIONS)(
    "serializes %s against its named advertised output contract",
    async (operation) => {
      const { root, target } = await createIdaTarget();
      roots.push(root);
      const client = new IdaSessionClient(
        {
          command: "fixture",
          args: [],
          env: {},
          mode,
          workspaceRoot: root,
          timeoutMs: 1000,
        },
        target,
        new RecordingIdaMcp(target, mode),
      );
      try {
        const parameters = parametersFor(operation);
        const execution = await client.execute(operation, parameters);
        if (mode === "headless" && operation === "procedure_callers") {
          expect(execution.ok).toBe(false);
          if (!execution.ok)
            expect(execution.error._tag).toBe(
              "AnalysisCapabilityUnavailableError",
            );
          return;
        }
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
        const serialized = toCallToolResult(
          { ok: true, value: evidence },
          contract,
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
